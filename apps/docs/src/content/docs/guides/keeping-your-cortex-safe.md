---
title: Keeping your cortex safe
description: Passphrases, recovery phrases, snapshots, auto-quarantine, and the safety nets Graphnosis puts between you and data loss.
sidebar:
  order: 5
---

Your cortex is the seahorse-shaped memory layer for your AI — the hippocampus of your stack. It lives on your machine, encrypted with a key only you hold. That means **Graphnosis can never reset your password or recover your data for you**. The good news: the app ships several layered safety nets so that "permanent data loss" requires a series of unlikely mistakes, not just one bad day.

This guide walks through each layer and what to do when.

## The five safety layers

| Layer | What it protects against | How to use it |
|------|---------------------------|---------------|
| **Passphrase** | Anyone else opening your cortex | Strong + memorable; stored in Keychain after first unlock |
| **24-word recovery phrase** | Forgetting your passphrase | Shown once at first unlock; written down somewhere offline |
| **Atomic writes** | Power loss / force-quit mid-save | Automatic — no action needed |
| **Auto-quarantine** | Corrupt files blocking unlock | Automatic — Graphnosis moves bad files aside on detection |
| **Snapshots** | "Oops, I didn't mean to recover/forget that" | Offered before destructive ops; created on demand |

---

## Passphrase

When you first create a cortex, you pick a passphrase. Graphnosis runs it through **Argon2id** (a slow, memory-hard hash) to derive a **wrapping key**. That wrapping key unlocks `master.enc`, which holds the actual **data key** that encrypts everything in your cortex.

This two-tier design (passphrase → wrapping key → data key → engrams) is why changing your passphrase is **instant**: only `master.enc` is rewritten. Your engrams, op-log, and embeddings are not re-encrypted.

### Unlocking with Touch ID (macOS)

After your first passphrase unlock — which stores the passphrase in your macOS Keychain — the lock screen shows an **👆 Touch ID** button next to the Unlock button. Click it, touch the sensor, and your cortex opens without typing the passphrase.

How it works: a small Swift sidecar binary (`graphnosis-biometric`) talks to Apple's LocalAuthentication.framework to evaluate biometric policy. On success, Graphnosis reads the stored passphrase from the Keychain and runs the regular unlock flow. The passphrase itself never leaves the Keychain; biometric just gates access to it.

If your Mac has no Touch ID sensor, no enrolled fingerprint, or biometric is disabled in System Settings, the button stays hidden — fall back to typing the passphrase.

### Changing your passphrase

Today there are two ways:

1. **Right after a recovery-phrase unlock**, Graphnosis automatically offers a "Set a new passphrase?" modal. This is the easiest path — you've already authenticated by entering your 24 words, so no old passphrase is required.
2. The same `change_passphrase` IPC exists; a dedicated Settings UI for routine rotations is on the roadmap. Until it ships, the post-recovery flow is the path.

In either case: your 24-word recovery phrase **remains valid** against the new passphrase. They are independent paths to the same data key.

---

## 24-word recovery phrase

A **BIP-39 mnemonic** (256-bit entropy → 24 English words) generated locally when you first set up your cortex. The phrase wraps a backup copy of your data key in `recovery.enc`, also stored locally inside your cortex folder.

**Where to keep it:**

- Password manager (1Password, Bitwarden, Apple Keychain) — different vault than your passphrase if possible
- Printed on paper in a safe place
- Ideally both

**Show me my phrase again?** No — it's shown once and never persisted in plaintext. If you didn't record it, treat your passphrase as your only key and don't lose it.

**Backfilling on a pre-v0.3 cortex.** If you created your cortex with an earlier version of Graphnosis, the recovery phrase didn't exist yet. On your next unlock with v0.3+, Graphnosis automatically:

1. Migrates your cortex to the wrapped-key format (writes `master.enc`).
2. Generates a fresh 24-word phrase and writes `recovery.enc`.
3. Shows you the phrase via the same one-time modal a fresh cortex sees.

You only get one chance to see it. Write it down before clicking through.

### Using the recovery phrase

If you forget your passphrase, click **"Forgot passphrase? Use recovery phrase"** under the Unlock button. Type the 24 words separated by spaces — order matters — and click **Recover access**.

What happens next:

- Your cortex unlocks for this session only (not saved to Keychain).
- A **"Set a new passphrase?"** modal pops up so you can pick a new passphrase you'll remember.
- The data key is unchanged. Your engrams, op-log, and embeddings are not re-encrypted.

See the [Recovery guide](/guides/recovery/) for the full walkthrough.

---

## Atomic writes

Every `.gai` engram and `.bundle` source-index write is now atomic: Graphnosis writes to a sibling `.tmp` file, calls `fsync` to push the bytes to stable storage, then atomically renames onto the target. POSIX `rename(2)` is atomic, so a process kill at any point leaves either the old file intact or the new file fully written — never a half-blob.

This closes the most common cause of cortex corruption: a save being interrupted mid-write during a long ingest (force-quit, OS kill on memory pressure, sudden power loss).

You don't have to do anything to enable this. As of v0.3 every save uses this path.

---

## Auto-quarantine

If Graphnosis detects a corrupt engram at startup — HMAC mismatch, signature failure, checksum failure on `loadFromBuffer` — it doesn't just keep retrying the same broken file forever. It:

1. Renames the bad file to `<engramId>.gai.corrupt-<timestamp>` and the matching `.bundle.corrupt-<timestamp>`.
2. Logs a clear `quarantined corrupt engram '<id>'` message to stderr.
3. Treats the engram as missing for the rest of the session — it disappears from the picker.

The quarantined files stay on disk forever; Graphnosis never auto-deletes them. You decide what to do with them via **Settings → Quarantined files**:

- **Restore** — rename back to canonical and try again on next unlock (only offered when no live canonical file exists; we won't overwrite a working engram).
- **Delete** — permanent. Requires you to type the exact engram name to confirm.

The Settings UI shows a status badge:

- `recovered ✓` — a live engram with the same ID currently exists, meaning you've already rebuilt it (typically via Recover from op-log). Safe to delete the quarantined copy.
- `not yet recovered` — there is no live copy. **Do not delete this without first running Recover from op-log** — the quarantined file is the only on-disk copy of these bytes.

---

## Recover from op-log

When you ingest a source, Graphnosis records an `ingestSource` event in the encrypted op-log with the source's reference (file path, URL, clip ID). If an engram is later lost — quarantined, accidentally deleted, never created on a fresh machine — you can rebuild it from the op-log: Graphnosis re-reads each source and re-ingests.

Open **Recover from op-log** from the app. The recovery panel shows every source ever ingested, grouped by engram, with per-item status:

| Status | What it means |
|--------|---------------|
| `recoverable` | The source's original file is still at the recorded path. Re-ingest will work. |
| `recoverable-from-cache` | The content blob is still in `content/`. No need to touch the original file. |
| `already-present` | Already in the current engram. No-op. |
| `file-missing` | File was moved or deleted, and content cache wasn't enabled at ingest. Unrecoverable from disk; consider re-ingesting manually. |
| `url-refetch-not-implemented` | URL source; URL refetch isn't built yet. |
| `content-not-in-oplog` | Clip / AI conversation without a cache blob. |

Click **Recover selected** to start. Recovery now:

- Runs in the background — close the panel and keep working.
- Shows live progress (source N of M, with current file name).
- Fires a native macOS notification when done.
- Offers to **save a snapshot first** so you can roll back if recovery produces an unexpected state.

For a multi-thousand-page PDF, recovery can take 60–90 minutes (same cost as the original ingest). You can use the app freely while it runs — just don't quit Graphnosis, or recovery aborts.

---

## Content cache

Each ingested file is also stored encrypted in `<cortex>/content/<sourceId>.bin` by default — up to **512 MB per source** (raised from 50 MB in v0.3 so realistic large reference manuals fit). This is the difference between:

- **Cache hit during recovery**: you can rebuild even if the original file has been moved or deleted.
- **Cache miss**: recovery only works if the original file is still at the exact path you ingested it from.

You can tune the cap or disable caching entirely in **Settings → Content cache**:

| Mode | Behavior |
|------|----------|
| `all` (default) | Cache everything within the size cap. Most resilient. |
| `ephemeral-only` | Cache clips, URL extracts, AI conversations — not files. Saves disk if you're tight. |
| `off` | Never cache. Recovery is best-effort from `ref` only. |

The cache is encrypted with the same data key as everything else.

---

## Snapshots

A **snapshot** is a point-in-time copy of every encrypted file in your cortex (engrams, bundles, embcache, content, `salt.bin`, `master.enc`, `recovery.enc`, settings). Stored under `<cortex>/.snapshots/<ISO-date>/`. Same encryption as the live files — your snapshots are not weaker than your cortex.

Graphnosis offers to create a snapshot before any of these operations:

- **Ingesting a file** — in case the new source produces unexpected nodes you'd want to revert.
- **Recover from op-log** — in case re-ingest produces a different shape than the original.
- **Changing your passphrase** — even though the operation is atomic and reversible (the recovery phrase keeps working), `master.enc` is critical, so snapshotting first is cheap insurance.

You can also create a snapshot any time from the app (Snapshots view) or list/restore them. Restore UX is intentionally minimal right now to avoid accidental rollbacks; if you need to restore, copy the snapshot directory's contents back over the live files manually while the app is quit.

**Snapshots are NOT auto-purged.** They cost disk space; review and delete old ones if you don't need them.

---

## What if everything goes wrong at once?

The doomsday scenario: lost passphrase, lost recovery phrase, corrupted `.gai`, no snapshot, original files moved.

If all five layers fail, your cortex is permanently inaccessible — and that's by design. Graphnosis has no master key, no Nehloo server, no back door. The encryption is real.

The realistic answer is to make it impossible for all five to fail simultaneously. The combination that actually matters:

1. **Write down your 24-word recovery phrase** the moment Graphnosis shows it. Two physical copies, different locations.
2. **Keep your original files where they were when you ingested them**, OR keep content cache enabled (default).
3. **Take a snapshot before any destructive operation** when Graphnosis offers (just hit Confirm).

Do those three things and the doomsday scenario stops being plausible.
