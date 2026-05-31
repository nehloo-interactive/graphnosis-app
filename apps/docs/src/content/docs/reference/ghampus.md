---
title: The story of Ghampus
description: Why Graphnosis has a seahorse for a logo, where the name Ghampus comes from, and what it stands for.
sidebar:
  order: 4
---

<img
  src="/graphnosis-logo.png"
  alt="Ghampus — the Graphnosis seahorse"
  width="180"
  height="180"
  style="float: right; margin: 0 0 1rem 1.5rem; width: 180px; height: 180px; shape-outside: circle();"
/>

Meet **Ghampus** — Graphnosis' seahorse mascot. He is the small character on the logo, on the lock screen, in the menu bar, and quietly at the heart of how Graphnosis thinks about your memory.

This page is the short version of his story.

## Why a seahorse?

The brain region responsible for memory is called the **hippocampus**. The word comes from the ancient Greek *hippókampos* (ἱππόκαμπος), literally *"horse-monster of the sea"* — a seahorse.

In 1564, the anatomist Julius Caesar Aranzi dissected a human brain, peered at the small curled structure deep in the medial temporal lobe, and decided: *that looks like a seahorse*. Five centuries later, every neuroscience textbook still calls it the hippocampus. The seahorse stuck.

So when the question came up — *what should Graphnosis look like?* — the answer was already in the etymology. Graphnosis is, functionally, a hippocampus for your AI: the part that takes raw experience, compresses it into compact memory traces (engrams), files them away, and retrieves the right one when something needs to be remembered. A seahorse for the part of the stack that is, literally, named after a seahorse.

## Where the name "Ghampus" comes from

**Ghampus** is a small portmanteau:

> <strong>G</strong>raphnosis + <strong>h</strong>ippoc<strong>ampus</strong> → <strong>Ghampus</strong>

The **G** carries the product. The **h** is the first letter of *hippocampus* — it lands the word where the brain region lands phonetically. The `ampus` is the tail of `hippocampus`, kept intact so the etymology stays visible. The result is a name that is easy to say in any language, short enough to fit on a chip in the status bar, and rooted in the neuroscience the product is built on.

He is pronounced **"GAM-pus"** — the `Gh` is a hard `G`, like in "ghost."

## What Ghampus stands for

Ghampus is not just decoration. He is a shorthand for the four things Graphnosis commits to, and the things every other "AI memory" product tends to quietly drop:

| Principle | What Ghampus promises |
|---|---|
| **Precision** | He retrieves the small, specific memory you need — not the whole document. Recall is a federated semantic search across your engrams, capped at the few hundred tokens that actually match your prompt. |
| **Privacy** | He lives on your machine. Your cortex is an encrypted local folder. No Nehloo servers are ever contacted. Memory content only ever leaves the device through the AI client you are actively using, for the conversation you are actively having. |
| **Security** | He is paranoid by default. Every cortex is encrypted at rest with libsodium `xchacha20poly1305`, keyed by Argon2id from your passphrase. The `.gai` engram files cannot be read without the passphrase — not by your AI, not by us, not by any tool that lands on your disk. |
| **Determinism** | He gives you the same answer to the same question, every time. The attested memory in `.gai` is byte-deterministic. The same query against the same cortex state returns the same memories — across runs, across AI clients, across days. No model in the loop, no probabilistic recall, no drift. |

The optional layers (the Neural Network overlay in `.gnn`, the Local LLM overlay in `.gll`) sit *beside* Ghampus' deterministic core — clearly labelled, opt-in, never mixed into the canonical graph. The four principles above apply to the attested layer always; the overlays are honest about being predictions.

## The brand stack

When you see the seahorse, follow the chain:

1. **The seahorse** (logo) reminds you of
2. **The hippocampus** (anatomy), which is the brain region for
3. **Encoding and retrieving memory** (function), which Graphnosis embodies as
4. **The sidecar / synapse + engram graph + `.gai` files** (software).

Every part of the product UI uses the same vocabulary:

- The cortex is your encrypted folder.
- Engrams are the indexed memory traces inside it.
- The synapse is the local background process that connects your AI client to the cortex (when you see *"Another Graphnosis synapse is already holding this cortex's lock"*, that is what it means).
- Ghampus is the character that ties it together — the friendly face of the hippocampus.

## Where you will spot him

- **The app logo** — menu bar, dock, lock screen, About panel.
- **The website** — favicon, the hero of the landing page, the upper-left wordmark.
- **Error states** — when the synapse is down or a cortex is locked, Ghampus is the one telling you, not a generic spinner.
- **The Skill Demos** — the three signed `.gsk` packs that ship with every fresh cortex carry his seal: signed with the Graphnosis Ed25519 publisher key, so you know the demo really came from him.

## A note on tone

Ghampus is friendly, but he is not chatty. He does not pop tutorials at you. He does not narrate what he is doing. He does the work, encrypted and quiet, and gets out of the way. The product is the same: deterministic, local, auditable, and as quiet as possible.

If you ever wonder *"is the AI really remembering this for me, or is it just guessing again?"* — that is exactly the question Ghampus exists to answer. The answer is in the `.gai` file, on your disk, in your hands.

---

## Related

[Overview](/getting-started/overview/) — how Graphnosis maps to the brain.

[Skills as SOPs](/reference/skills/) — what Ghampus does for procedural memory.

[Federated Multi-Graphs](/reference/federated-multi-graphs/) — the dual graph and federation he keeps running.

[File Formats](/reference/file-formats/) — the `.gai`, `.gnn`, `.gll`, and `.gsk` files he writes.

[Indelibility & Determinism](/guides/indelibility-and-determinism/) — the trust spine behind his four principles.

