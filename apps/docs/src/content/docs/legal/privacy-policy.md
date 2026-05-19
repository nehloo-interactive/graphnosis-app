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

Nehloo Interactive operates **no servers that receive your personal data**. We have no data centers where your Cortex is stored. We run no analytics pipelines processing your behavior. We collect no telemetry. When you use Graphnosis, your data does not travel to us — ever.

This is an architectural choice, not just a policy. The application is designed so that personal data physically cannot reach our infrastructure because our infrastructure is not in the loop.

---

## 3. What is stored and where

### 3.1 Your Cortex — local, encrypted

All graph data — your memories, nodes, source records, embeddings, and the op-log — are stored in the **Cortex folder** you choose on your own device. Files are encrypted at rest using **libsodium `crypto_secretstream_xchacha20poly1305`**, with a key derived from your passphrase via **Argon2id**. Without your passphrase (or the 24-word recovery phrase shown once at setup), the files are unreadable ciphertext.

Nehloo Interactive does not hold a copy of your passphrase, your recovery phrase, or your encryption key. If you lose both, the data is unrecoverable. We cannot help you recover it.

### 3.2 What the Cortex folder contains

- `.gai` files — encrypted serialized knowledge graphs
- An encrypted op-log (append-only event log used for multi-device sync)
- A model cache directory — see §4.1 below
- Socket files (`.sock`) — ephemeral, local process communication only

### 3.3 Keychain storage

On macOS, after you first unlock your Cortex, the passphrase is stored in the **macOS Keychain** (the system secure enclave). This is local OS-level storage; Nehloo Interactive does not have access to it. On Windows, the Windows Credential Manager is used equivalently.

---

## 4. The only network activity Graphnosis initiates

### 4.1 Embedding model download (one-time)

On first use, Graphnosis downloads the **BGE-small-en-v1.5** embedding model (~35 MB) from Hugging Face Hub to your local model cache. After that, all inference runs offline on your device. No personal data is sent during this download — only a standard HTTP request for a public model file. You can pre-stage the model manually to avoid this network call entirely.

**No other outbound network connections are made by Graphnosis itself.** The app does not check for updates automatically, does not send error reports, and does not ping any Nehloo Interactive endpoint.

---

## 5. Third-party AI clients — when data moves and how

This is the most important section for your privacy.

### 5.1 The precise conditions for any data to leave your device

Memory content leaves your device **only** when all of the following are true simultaneously:

1. You have an AI client open and actively connected to Graphnosis via MCP.
2. You are engaged in a conversation — asking a question, sending a message.
3. The AI client calls the `recall` tool in the context of that conversation.

If your AI client is closed, nothing moves. If it is open but you are not actively conversing, nothing moves. Your Cortex does not broadcast, sync, or transmit anything on its own. It is entirely passive.

### 5.2 What the AI provider receives — and how small it is

When `recall` fires, Graphnosis does not send your documents, your files, or your full graph. It:

1. Runs a semantic search against your local engram graph — entirely on your device.
2. Selects only the memory nodes most relevant to your current query.
3. Enforces your sensitivity tier caps (see §5.3 below).
4. Formats the selected nodes as a plain-text context block.

**That context block — and only that context block — is what the AI provider receives.** It contains a small, curated excerpt of the memories relevant to the question you are asking right now. The rest of your Cortex stays encrypted on your device, unread and unsent. Across a typical conversation, this amounts to a few hundred to a few thousand words — a fraction of what you've ingested.

This is architecturally different from approaches that dump your files into AI context windows. Graphnosis encodes content into binary engrams (`.gai` format) on ingest; the AI never receives raw files. On recall, it receives only decoded, semantically filtered excerpts.

The recalled text is processed by the AI provider (Anthropic, OpenAI, etc.) under **their** privacy policy, not ours. Nehloo Interactive is not a party to that exchange. We do not see it, log it, or store a copy of it.

**Before you ingest sensitive information**, we strongly recommend reviewing the privacy policy of the AI clients you connect to Graphnosis:
- [Anthropic (Claude) Privacy Policy](https://www.anthropic.com/privacy)
- [OpenAI Privacy Policy](https://openai.com/privacy)
- [GitHub Copilot / Microsoft Privacy Statement](https://privacy.microsoft.com/en-us/privacystatement)

These policies may change. Nehloo Interactive is not responsible for how third-party AI providers process data you share with them through or alongside Graphnosis.

### 5.3 Sensitivity tiers — hard limits you set

Every graph in your Cortex has a sensitivity tier. These limits are enforced by the Graphnosis sidecar before any content is returned to an AI client. The AI cannot override them.

| Tier | What gets recalled |
|---|---|
| `public` | Up to 50 nodes / 8,000 tokens per recall |
| `personal` | Up to 50 nodes / 8,000 tokens per recall |
| `sensitive` | Zero — nothing from this graph is ever sent to an AI client |

Sensitive-tier graphs are fully blocked from AI access. The AI receives no results and no indication of what exists in that graph.

### 5.4 You decide what goes in and what tier it gets

Graphnosis gives you explicit control at every stage:
- **You choose what to ingest.** Nothing is ingested automatically. Graphnosis only processes what you explicitly add.
- **You assign sensitivity tiers to graphs.** You decide what gets protected.
- **You can forget at any time.** The `forget` tool permanently removes a source and all derived nodes from your Cortex. There is no recycle bin, no soft delete.

---

## 6. Optional cloud storage (iCloud, Dropbox, Google Drive, etc.)

If you store your Cortex folder inside iCloud Drive, Dropbox, Google Drive, OneDrive, or any similar cloud storage service, those files will be synced to that service's servers. **This is entirely your choice and under your control.** The files remain encrypted (the cloud service sees only ciphertext), but that service's privacy policy applies to the encrypted blobs it stores.

Nehloo Interactive is not affiliated with any cloud storage provider and does not recommend or require their use. Graphnosis works entirely with a local folder.

---

## 7. Children's privacy

Graphnosis is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. Since we collect no personal information from anyone, this is a structural guarantee. If you believe a child under 13 is using Graphnosis, please contact us.

---

## 8. Data security

We have designed Graphnosis so that your data security does not depend on trusting us. Strong encryption, local-only storage, and no cloud backend mean that even a complete compromise of Nehloo Interactive's infrastructure would not expose your Cortex data.

That said, the security of your Cortex also depends on:
- The strength and confidentiality of your passphrase
- The physical security of your device
- The security practices of any cloud storage service you choose
- The security of the AI clients you connect

We recommend using a strong, unique passphrase and storing your 24-word recovery phrase securely offline.

### 8.1 Programmatic access — both libraries are open source

Both libraries that underpin Graphnosis are open source under the [Functional Source License (FSL-1.1)](https://fsl.software):

- **`@nehloo/graphnosis`** — defines the `.gai` binary graph format; parse and query engram graphs
- **`@nehloo-interactive/graphnosis-secure-sync`** — the encryption layer; the `GNAPP\x01` format used to wrap and protect `.gai` files on disk

This is intentional. We believe your data should never be locked behind proprietary tooling that only we control. You can inspect, export, migrate, or build on top of your own Cortex using these libraries — and you can audit exactly how your data is encrypted.

**What this means in practice:**

A power user or developer with both libraries can decrypt and read their own Cortex programmatically:

```
decrypt(cortex_file, your_passphrase)   // graphnosis-secure-sync → removes GNAPP\x01 wrapper
→ raw .gai bytes
parse(raw_gai_bytes)                    // @nehloo/graphnosis → deserializes the graph
→ nodes, edges, metadata
```

**The passphrase is still the only gate.** The open-source libraries do not provide any bypass. Someone who has a copy of your Cortex folder but does not know your passphrase cannot read anything — the encryption does not depend on the libraries being secret. Auditable crypto is stronger crypto.

This also means you are not locked in. If Nehloo Interactive ever ceased to exist, you would still have full access to your own data using the open-source libraries and your passphrase. Your memory belongs to you.

### 8.2 Cortex portability — what "passphrase is the key" means

The Cortex folder is **portable by design**. The encryption salt is embedded inside each encrypted file, not tied to the machine it was created on. This enables the cloud sync use case (iCloud Drive, Dropbox, etc.) and lets you migrate your Cortex to a new device without any re-encryption step.

**What this means for security:**

- If someone obtains a copy of your entire Cortex folder AND knows your passphrase, they can open that Cortex on any machine using Graphnosis or the SDK.
- If someone obtains a copy of your Cortex folder but does NOT know your passphrase, they cannot read anything. The files are Argon2id-hardened ciphertext. Brute-forcing a strong passphrase is computationally infeasible with current hardware.
- Graphnosis does not implement device binding (tying decryption to a specific machine's hardware key). Device binding would make the Cortex unrecoverable if your device fails, even with your recovery phrase. We believe this tradeoff is wrong for a personal knowledge tool. The passphrase is the secret.

**The practical implication:** treat your passphrase with the same care you would treat the data itself. A weak passphrase is a weak lock. A strong, unique passphrase — combined with not storing it anywhere obvious — means your Cortex is secure even if the encrypted files are copied.

---

## 9. Changes to this policy

We may update this Privacy Policy from time to time. When we do, we will update the "Last updated" date at the top. Material changes will be noted in the release notes accompanying app updates. Continued use of Graphnosis after a policy change constitutes acceptance of the new terms.

---

## 10. Contact

For privacy questions or concerns:

**Nehloo Interactive LLC**
Email: privacy@graphnosis.com
Website: https://graphnosis.com

---

*This Privacy Policy should be read alongside our [Terms of Use](/legal/terms-of-use). This policy does not constitute legal advice. If you have specific legal or compliance requirements, consult a qualified attorney.*
