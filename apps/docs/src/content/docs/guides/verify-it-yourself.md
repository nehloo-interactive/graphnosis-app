---
title: Verify It Yourself
description: Graphnosis' privacy promises are verifiable, not just asserted — watch the network, audit the encryption, and decrypt your own cortex.
sidebar:
  order: 7
---

Graphnosis makes strong claims: your data stays on your machine, the encryption is real, nothing is locked in. You do not have to take any of that on faith. Every one of those promises is something you can check yourself — with a network monitor, the source code, or your own passphrase. This page shows you how.

## Watch the network

The strongest privacy claim Graphnosis makes is that your cortex never leaves your device. You can confirm it directly.

Point a network monitor at the app — Little Snitch, the macOS Activity Monitor's Network tab, or `lsof -i` from a terminal. Outside of two cases, you will see no outbound traffic at all:

- **The one-time embedding-model download.** On first run, Graphnosis fetches the BGE-small-en-v1.5 model from Hugging Face. After that it never downloads it again, and you can pre-stage the model to skip even this.
- **Any connectors you set up.** A connector pulls content *from* a service you chose, on a schedule you set. If you configure none, there is nothing here to see.

That is the complete list — see [Privacy Policy §4](/legal/privacy-policy/) for the precise wording. There is no telemetry, no analytics, no update ping, no Nehloo Interactive endpoint.

The simplest test of all: **turn Wi-Fi off.** Recall still works. Ingest still works. Adding the bundled Graphnosis docs to your cortex still works. None of the core app needs a network, because none of it talks to a server.

## Audit the encryption

You do not have to trust that the encryption is sound — you can read it. Both libraries Graphnosis uses for storage and crypto are open to inspect:

- **`@nehloo/graphnosis`** — the engram graph engine and the `.gai` graph format. Open source under **Apache-2.0**.
- **`@nehloo-interactive/graphnosis-secure-sync`** — the encryption layer: the `GNAPP\x01` envelope, **XChaCha20-Poly1305** for authenticated encryption, and **Argon2id** for deriving the key from your passphrase. Source-available under **FSL-1.1**.

Both live in the GitHub organization at [github.com/nehloo-interactive](https://github.com/nehloo-interactive). The security of your cortex does not depend on these libraries being secret — it depends only on your passphrase. Auditable crypto is stronger crypto: an algorithm anyone can inspect is one whose weaknesses surface and get fixed, rather than hiding.

## Decrypt your own cortex

The clearest proof that your data is not locked in: you can read it yourself, without the Graphnosis app.

With the two libraries above and your passphrase, you can decrypt and parse your `.gai` files directly — for exports, backups, custom tooling, or migrating to something else entirely. This is deliberate. Graphnosis is a place your memory lives, not a vault that holds it hostage. If the app vanished tomorrow, your cortex would still be yours and still be readable.

The on-disk layout — the `GNAPP\x01` envelope, the header, the encrypted payload — is documented in [File Formats](/reference/file-formats/), and the data-flow guarantees are spelled out in the [Privacy Policy](/legal/privacy-policy/).

## The app is source-available

Graphnosis itself — not just its crypto libraries — is **source-available under FSL-1.1**. You can read the whole application: how it ingests, how it recalls, what it writes to disk, what it sends and when. You can audit it, fork it, and self-host it.

FSL-1.1 is not a traditional open-source license — it carries a non-compete clause that converts to Apache 2.0 after two years — but for the purpose that matters here, it gives you everything: full visibility into exactly what the software does with your data.

## Found a bug, or have feedback?

If something is broken, behaves unexpectedly, or you have an idea for how Graphnosis could be better, open an issue. Bug reports and feature requests both go to GitHub Issues:

**[github.com/nehloo-interactive/graphnosis-app/issues](https://github.com/nehloo-interactive/graphnosis-app/issues)**

A good bug report includes what you did, what you expected, and what happened instead — and, if the app showed one, the synapse error message. Feature requests are welcome too; describe the problem you are trying to solve, not just the solution you have in mind.
