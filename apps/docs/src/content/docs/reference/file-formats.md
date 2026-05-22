---
title: File Formats
description: Internal file formats used by Graphnosis — encrypted archives, op-log structure, and model cache.
sidebar:
  order: 3
---

This page documents the file formats Graphnosis creates and manages on disk. You won't normally need to interact with these directly, but this is useful for troubleshooting, backup planning, and building tooling.

## `.gai` — Encrypted Graph Archive

A `.gai` file is a portable export of one or more graphs from a Cortex. It is produced when you use **Export Graph** from the UI, and consumed when you **Import Graph** into another Cortex.

### Structure

A `.gai` file is a binary container with the following layout:

```
[4 bytes]  Magic: 0x47 0x41 0x49 0x01  ("GAI\x01")
[4 bytes]  Header length (little-endian uint32)
[N bytes]  JSON header (UTF-8, see below)
[M bytes]  Encrypted payload (libsodium secretstream)
```

The JSON header contains:

```json
{
  "version": 1,
  "graphNames": ["work"],
  "exportedAt": "2025-03-14T10:00:00Z",
  "chunkCount": 1823,
  "embeddingModel": "BGE-small-en-v1.5",
  "embeddingDimensions": 384
}
```

The encrypted payload is a MessagePack-serialized array of source and chunk records. It is encrypted with the exporting Cortex's key using xchacha20poly1305 secretstream.

:::note
When importing a `.gai` file into a different Cortex, you must also provide the passphrase (or recovery phrase) of the exporting Cortex. The import UI prompts for this.
:::

## `.gnn` — Neural Network Prediction Overlay

The **Graphnosis Neural Network (GNN)** is an opt-in, off-by-default link predictor. When you enable it from the **Go Non-Deterministic** tab, it trains a small model on your engrams and proposes connections it judges *likely real but not yet recorded*.

Those predictions are **never written into the deterministic `.gai` graph.** They live in a separate overlay file, one per Cortex:

```
<cortex>/neural-network.gnn
```

### Why a separate file

Core recall traverses only `.gai`, so the same query always returns the same result — the graph is deterministic. The GNN is *non-deterministic*: two training runs can differ. Isolating its output in its own file guarantees:

- **The deterministic graph stays pure.** No prediction can silently change a recall answer.
- **Undo is trivial.** "Remove all predicted connections" simply discards this file; the `.gai` graph is never touched.
- **Predictions are always labelled.** They surface only in the clearly-marked recall-enrichment section and the 3D Engram's toggleable prediction layer (dashed edges) — never inside a deterministic answer.

### Structure

`.gnn` is encrypted with the Cortex data key using XChaCha20-Poly1305 — the same primitive as `.gai`, because it records node ids. Decrypted, it is a small versioned JSON envelope:

```json
{
  "version": 1,
  "edges": [
    {
      "id": "a1b2c3d4e5f6a7b8",
      "graphId": "work",
      "from": "<node id>",
      "to": "<node id>",
      "score": 0.87,
      "createdAt": 1716290000000
    }
  ]
}
```

Each entry is one predicted edge: the engram it belongs to, the two endpoint node ids, the model's confidence (`score`, 0–1), and when it was predicted.

:::note
Deleting `neural-network.gnn` is safe — it only removes the prediction overlay. Your memories and their real connections live in the `.gai` graph and are unaffected; the app simply re-creates the overlay the next time the neural network runs (if it is still enabled).
:::

## Op-log

The op-log is an append-only event log stored in `cortex.db` (SQLite, encrypted). Every mutation to the Cortex is recorded as an op-log event before it is applied.

### Event types

| Event type | Triggered by |
|-----------|-------------|
| `ingest` | A new source is added (file, URL, or clip). |
| `reingest` | An existing source is re-processed. |
| `correction` | A chunk is updated via the correction flow. |
| `forget` | A chunk or source is deleted. |
| `graph_create` | A new graph is created. |
| `graph_config` | Graph settings (tier, token cap) are changed. |
| `passphrase_change` | The Cortex passphrase is changed. |
| `recovery_apply` | A recovery operation is applied via `recover.js`. |

### Op-log record structure

Each event is a MessagePack row in the `op_log` table with the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique event identifier |
| `type` | string | Event type (see table above) |
| `ts` | integer | Unix timestamp in milliseconds |
| `graphName` | string | Graph the event applies to |
| `payload` | bytes | MessagePack-encoded event-specific data |

The `payload` field is also encrypted. The schema of each payload type is defined in the `@nehloo/graphnosis` SDK source.

## Model cache

The local embedding model is stored in the `models/` subdirectory of your Cortex folder (unless the embedding cache directory is overridden with `GRAPHNOSIS_EMBED_CACHE`).

```
<cortex>/models/
  bge-small-en-v1.5/
    model.onnx           (~90 MB, the ONNX model weights)
    tokenizer.json       (HuggingFace tokenizer config)
    special_tokens_map.json
    config.json
```

The model is downloaded automatically on first ingest from Hugging Face Hub (`BAAI/bge-small-en-v1.5`). No login is required. If you need to pre-seed the model (for offline use), copy a valid model directory to this path before first use.

The model files are not encrypted — they are public model weights and contain no user data.

## `policy.json`

See [Graphs & Sensitivity Tiers](/guides/graphs-and-tiers/) for the full format. This file is plain JSON, not encrypted, and is safe to inspect and edit in a text editor.

## `salt.bin`

The Argon2id salt used to derive your **wrap key** from the passphrase. Public — not secret. Required to re-derive the wrap key on every unlock; without it, even the correct passphrase produces the wrong key. **Never delete `salt.bin`.**

## `master.enc`

The persistent **data key** for your Cortex, wrapped with the Argon2id wrap key derived from your passphrase. Cortex unlock flow:

```
passphrase + salt.bin ──Argon2id──▶ wrapKey ──decrypts──▶ master.enc ──▶ dataKey ──encrypts──▶ every .gai / .bundle / .embcache / content blob / op-log
```

Two-tier design means a passphrase change rewrites only this 99-byte file — your engrams stay encrypted with the same data key and are never touched. Cortexes from before v0.3 don't have `master.enc`; the first unlock with v0.3+ auto-migrates by writing it.

## `recovery.enc`

The same data key, wrapped a second time with an Argon2id-derived key from your **24-word BIP-39 recovery phrase**. Independent of the passphrase path — entering the phrase unwraps `recovery.enc` directly to retrieve the data key, no passphrase needed. Generated once at cortex creation (or backfilled on the first v0.3 unlock for a pre-v0.3 cortex); regeneratable from **Settings → Recovery phrase**.

If you lose **both** the passphrase and the recovery phrase, neither file can be opened by anyone and your Cortex is permanently inaccessible. By design.

## `.gai.corrupt-<timestamp>` / `.bundle.corrupt-<timestamp>`

Quarantined files. When Graphnosis loads a `.gai` and the SDK's HMAC check fails, the file is auto-renamed with this suffix so the next unlock doesn't keep retrying it. Manage them from **Settings → Cortex Management → Quarantined files** (restore or delete with typed confirmation). Never auto-deleted.

## Atomic writes

Every `.gai`, `.bundle`, and `master.enc` write goes through an atomic write helper: write to a sibling `.tmp` file, `fsync` to stable storage, then `rename(2)` onto the canonical name. POSIX rename is atomic, so a process kill at any point leaves either the old file intact or the new one fully written — never a half-blob. This closed the primary cause of `.gai` checksum-mismatch corruption seen in pre-v0.3 cortexes.
