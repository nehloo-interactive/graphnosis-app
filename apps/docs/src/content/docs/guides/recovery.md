---
title: Recovery
description: How to recover your cortex using the 24-word recovery phrase.
sidebar:
  order: 4
---

If you ever forget your passphrase, the 24-word recovery phrase is your fallback.

## How it works

When you create a brand-new cortex, Graphnosis generates a **24-word BIP-39 mnemonic** (256 bits of entropy). The phrase encrypts a backup copy of your data-encryption key, stored on disk as `recovery.enc` inside your cortex folder.

**Two independent paths to your data:**

| Path | What you enter | What it does |
|------|----------------|--------------|
| Normal unlock | Passphrase | Argon2id derives the data key from your passphrase + salt. |
| Recovery unlock | 24-word phrase | Decrypts `recovery.enc` to retrieve the data key directly. |

Both arrive at the same key. Both succeed only with the correct input. Both happen entirely on your machine — Graphnosis has no servers and no master key.

:::caution
The phrase is shown **exactly once**, right after the cortex is created. After you dismiss the modal there is no way to display it again from the app. If you lose both your passphrase **and** the phrase, your cortex is permanently inaccessible. There is no recovery from that — by design.
:::

## Where to keep the phrase

- A password manager (1Password, Bitwarden, Apple Keychain) — separate from your passphrase if possible
- A printed note in a safe, lockbox, or sealed envelope
- A piece of paper in your wallet or with your important documents
- Ideally, in **more than one** of the above

Anywhere you would keep something you cannot regenerate.

## Recovering access in the app

1. Open Graphnosis. On the unlock screen, click **"Forgot passphrase? Use recovery phrase"** below the Unlock button.
2. A 24-word input area appears. Type or paste your phrase (space-separated, order matters).
3. Click **Recover access**. The app reads `recovery.enc`, decrypts it with your phrase, and unlocks the cortex for this session.

If the phrase is wrong, the app surfaces a "Wrong recovery phrase" error. Order matters — check every word and try again.

## After recovery

A recovery-mode unlock does **not** persist anything to your Mac's Keychain. The cortex stays unlocked only for the current session — next time you launch the app you'll see the unlock screen again.

### Set a new passphrase (offered automatically)

The moment your cortex unlocks via recovery, Graphnosis offers a **"Set a new passphrase?"** modal. Picking a new passphrase here:

- Is **instant** — only the wrapping key in `master.enc` is rewritten. Your engrams, op-log, content cache, and embeddings are not re-encrypted. The data key stays the same.
- Is **safe** — your 24-word recovery phrase remains valid against the new passphrase, because the recovery phrase wraps the same persistent data key.
- Saves the new passphrase to your Mac's **Keychain** so the next launch auto-unlocks the cortex without re-prompting.

You can also click **Skip for now** — your old (forgotten) passphrase would still technically work if you ever recall it, but for most people the cleaner path is to just set a fresh one right after recovery.

If you skipped and want to change the passphrase later: that flow isn't surfaced from the unlock screen yet, but it's the same `change_passphrase` call under the hood. Until a Settings UI ships, the post-recovery flow is the path.

### Does Graphnosis give me a new recovery phrase?

**Not automatically — but you can ask for one any time** via **Settings → Recovery phrase → Regenerate recovery phrase**. The flow:

1. Settings opens, you click **Regenerate recovery phrase…**.
2. A typed-confirmation modal appears. You type `regenerate recovery phrase` to confirm.
3. Graphnosis generates a fresh 24-word phrase, atomically replaces `recovery.enc`, and shows you the new phrase in the same one-time modal a fresh cortex sees.
4. The OLD phrase stops working immediately. The NEW phrase is now the only fallback to the passphrase.

The data key is preserved — every engram, embcache, op-log entry, and content blob still decrypts with the same key. Only the wrapper changes.

When to regenerate:

- **You never saw the original phrase** (e.g. the one-time modal was missed during a legacy-cortex migration, or you dismissed it without writing the words down)
- **You believe the old phrase was exposed** (accidentally screenshotted into a synced album, written on a sticky note that vanished, typed into the wrong window)
- **Periodic rotation** as part of a personal security hygiene routine

By default, using your recovery phrase to unlock once does NOT regenerate it. The decryption happens entirely on your machine, the phrase never leaves your device, and no one else can know you used it. Treat your phrase like a master key: keep using it for as long as you trust your storage of it.

### Why we don't auto-regenerate

Generating a new phrase silently after every recovery would mean a user who recovers, doesn't notice the new phrase, and closes the app is now locked out forever — their old written-down phrase no longer works, and they never saw the new one. Auto-rotation here is a footgun. Manual regeneration via Settings is the explicit, deliberate path.

### What about my passphrase?

Your old passphrase is unchanged by default. If you eventually remember it (or find it in your password manager), it still works. Recovery is a fallback, not a reset — it doesn't invalidate anything.

If you want a different passphrase, the **"Set a new passphrase?"** modal that appears right after recovery is the easiest path. Picking a new one there *does* invalidate the old one (rewraps `master.enc` so the old passphrase no longer decrypts the data key). The recovery phrase keeps working.

## Moving a cortex to a new machine

The cortex folder is fully portable. To move:

1. Copy the entire cortex folder (everything inside it) to the new machine — usually via iCloud Drive, Dropbox, an external disk, or `rsync`.
2. Open Graphnosis on the new machine. Point it at the folder. Enter your passphrase.

That's it. No re-setup, no key import, no re-ingest. The `recovery.enc` file moves with the cortex, so your fallback path is preserved.

## What if `recovery.enc` is missing?

cortexes created with versions of Graphnosis older than v0.3 (which introduced the recovery phrase) do **not** have a `recovery.enc` file. For those cortexes:

- Continue using your passphrase as normal.
- On the next major version that ships the re-passphrase flow, you will be prompted to generate a recovery phrase for your existing cortex.

If you try to "Recover access" on a cortex without `recovery.enc`, the app will tell you so.

## Corrupted or lost data

Recovery phrase = recovery of the **key**. It does not heal a corrupted graph file.

If your `.gai` file or `.bundle` is corrupt (e.g. interrupted disk write, partial sync), the **Recover from op-log** flow is the path: it replays the encrypted op-log to rebuild your sources. It runs from the unlocked app, not from the recovery phrase modal.

### Auto-quarantine

When Graphnosis detects a corrupt `.gai` at startup (HMAC mismatch, invalid checksum, signature failure), it automatically:

1. Renames the bad file to `<name>.gai.corrupt-<timestamp>` (and the matching `.bundle.corrupt-<timestamp>`).
2. Logs a clear `quarantined corrupt engram '<id>'` line to stderr.
3. Treats the engram as missing for the rest of the session — it disappears from the picker.

The quarantined files stay on disk forever; Graphnosis never auto-deletes them. You can:

- **Restore them manually** if you have reason to believe the file is actually fine (e.g. you accidentally renamed something during testing) — just rename them back to `.gai` / `.bundle` and restart.
- **Rebuild from op-log** via the **Recover from op-log** panel — Graphnosis walks the encrypted op-log, finds every source ever ingested into the quarantined engram, and re-ingests from the cached content blobs (if content cache was on) or from the original files (if they're still at the recorded path).
- **Delete them** once you're sure rebuild worked: `rm <cortex>/graphs/*.corrupt-*`.

### Recovery runs in the background

Re-ingesting a large source — e.g. a multi-thousand-page PDF — can take **60 to 90 minutes**. The Recover panel hands the work off to the sidecar and shows a live progress bar while it runs. You can:

- **Close the panel** and keep using Graphnosis (browse other engrams, ingest other files, talk to your AI client through the synapse). The recovery keeps running.
- **Re-open the panel** at any time to see current progress.
- **Quit the app** — and the recovery aborts. Whatever sources finished are saved; partial sources are not. Pick up where you left off the next time you open the panel.

A native macOS notification fires when the recovery finishes, regardless of which view you're on.

### Why corruption happens in the first place

The usual cause is a `save()` being interrupted mid-write — force-quit, OS kill (low memory), or a crash during the multi-second window it takes to encrypt and persist a large engram. As of Graphnosis v0.3, every `.gai` / `.bundle` write is **atomic**: the sidecar writes to a sibling `.tmp` file, `fsync`s it to stable storage, then `rename`s it onto the final path. POSIX `rename(2)` is atomic, so a process kill at any point leaves either the old file intact or the new file fully written — never a half-blob. This class of corruption shouldn't recur on cortexes created with v0.3 or later.
