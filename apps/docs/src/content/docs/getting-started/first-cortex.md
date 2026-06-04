---
title: Install & First Cortex
description: Download the app, create your first Cortex, and understand what gets stored where.
sidebar:
  order: 2
---

## 1. Download and open the app

Download the latest `.dmg` from [graphnosis.com](https://graphnosis.com) and drag Graphnosis to your Applications folder. On first launch, macOS may ask you to confirm opening an app from an identified developer — click **Open**.

A small icon appears in your menu bar. That's Graphnosis running. It has no Dock icon by default.

## 2. Create a Cortex

Click the menu bar icon and choose **New Cortex**.

You'll be asked to:

1. **Choose a folder** — this is where Graphnosis will store all your encrypted data. Pick a location you control: `~/Documents/MyCortex`, an external drive, or a synced folder like iCloud Drive. If you use a synced folder, only the encrypted files ever leave your machine.
2. **Set a passphrase** — choose something strong and memorable. This passphrase is the only way to unlock your Cortex. Graphnosis derives the encryption key from it using Argon2id — there is no "forgot my password" flow.
3. **Save your recovery phrase** — after setting the passphrase, Graphnosis generates a **24-word BIP-39 recovery phrase**. Write it down and store it somewhere safe (offline, not in a notes app). This phrase is the only alternative way to recover your data if you forget your passphrase or lose your device.

:::caution
If you lose both your passphrase and your recovery phrase, your Cortex data is permanently unrecoverable. Graphnosis has no master key and no server copy.
:::

## 3. What gets stored where

After creating a Cortex, your chosen folder will contain:

| Path | What it is |
|------|-----------|
| `graphs/<name>.gai` | Encrypted engram (memory graph): nodes, edges, content, metadata |
| `graphs/<name>.bundle` | Encrypted source index (which files/clips fed each engram) |
| `graphs/<name>.embcache` | Encrypted embedding cache (vector index for semantic search) |
| `oplog/` | Encrypted append-only audit log (every ingest, edit, forget) |
| `content/` | Encrypted source blobs (when content cache is enabled in Settings) |
| `.snapshots/` | Optional point-in-time encrypted backups |
| `salt.bin` | Argon2id salt (public — needed to re-derive your key from your passphrase) |
| `recovery.enc` | Backup copy of your data key, encrypted with your **24-word recovery phrase** |
| `settings.json` | Graphnosis app settings + engram metadata (no memory content) |

No unencrypted content is ever written to disk. Every `.gai`, `.bundle`, `.embcache`, op-log entry, and cached blob is sealed with your data key.

`recovery.enc` is a separate sealed copy of the same data key, wrapped with your 24-word phrase. If you ever forget the passphrase, the phrase can unwrap it. If you have the passphrase, you never need to touch `recovery.enc`.

## 4. Unlock the Cortex

If you quit and reopen the app, or lock the Cortex manually, you'll be prompted for your passphrase. The app holds the derived key in memory while unlocked — it is never written to disk.

**Touch ID (macOS only).** After your first successful passphrase unlock — when Graphnosis stores the passphrase in your macOS Keychain — the lock screen shows an **👆 Touch ID** button next to Unlock. Click it, touch the sensor, and you're in without typing the passphrase. The passphrase itself never leaves the Keychain; Touch ID just gates access to it.

**Forgot your passphrase?** Click "Forgot passphrase? Use recovery phrase" under the Unlock button and enter your 24 words. See [Recovery](/guides/recovery/) for the full flow.

You can lock the Cortex any time from the menu bar icon.

## 5. Keep Graphnosis running for AI clients

For Claude (or any other MCP-compatible AI client) to read from your Cortex, **the Graphnosis app must be running and the Cortex must be unlocked**:

- **App closed / quit** → no AI client can reach your memories. They will fall back to whatever context you give them in chat.
- **App running, Cortex locked** → still no access. The encryption key is not in memory until you unlock.
- **App running, Cortex unlocked** → AI clients connect through Graphnosis on demand, and only the small slice of memories relevant to the prompt leaves the app.

You can close the main window (⌘W) — the app continues running in the menu bar. Use the tray icon's **Quit** option to fully stop it.

## 6. Next step

With your Cortex running, follow the [Connect Your AI](/getting-started/connect-ai/) guide to wire Graphnosis into your AI client.

And once you're set up, take five minutes to read **[Keeping your Cortex safe](/guides/keeping-your-cortex-safe/)** — it walks through the five safety layers (passphrase, recovery phrase, atomic writes, auto-quarantine, snapshots) and how to use them. The most important thing is to **write down your 24-word recovery phrase** the moment the modal shows it — Graphnosis can't show it to you again.
