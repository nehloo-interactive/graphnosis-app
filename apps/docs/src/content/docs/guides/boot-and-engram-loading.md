---
title: Boot & engram loading
description: How Graphnosis loads your engrams on unlock — preferred default, sequential background loading, status bar progress, and what the greyed-out engrams in the picker mean.
sidebar:
  order: 8
---

When you unlock your cortex, Graphnosis doesn't load every engram at once
into memory — that would freeze the app on large cortexes. Instead it loads
**one engram first** so you see content immediately, then streams the rest
in the background while you're already working.

This page explains what you see during boot, why it works that way, and
how to read the status bar and engram picker.

## The boot sequence

1. **You type your passphrase (or Touch ID).** The lock screen shows
   "Loading memories…".
2. **The sidecar acquires the cortex lock** and loads exactly one
   engram — your **preferred default**.
3. **The app reveals** with that engram already shown — its memories in
   the Check-in deck, its picker selection in the topbar, its data in
   the 3D engram tab.
4. **In the background**, the sidecar loads the rest of your engrams
   one at a time. The status bar shows "Loading N more engrams…" with
   a live countdown.
5. **The engram picker fills in** as each background load completes —
   pending engrams are visible from the start but greyed out until
   their data is ready.

On a fresh cortex with one engram, steps 4–5 don't happen. On a cortex
with 12 engrams, the reveal at step 3 happens in about 3 seconds and
the rest stream in over the next 5–6 seconds. Startup is significantly
faster for large cortexes compared to earlier versions — op-log
compaction on unlock reduces the amount of data replayed before the
first engram is ready.

## Which engram loads first?

The "preferred default" is, in priority order:

1. **The engram you had selected last session** — Graphnosis stores this
   in `localStorage` (`graphnosis:lastActiveEngram`) and passes it to the
   sidecar at unlock as the `GRAPHNOSIS_DEFAULT_GRAPH` env var. So if
   you were last working in **Book Notes**, Book Notes is what loads.
2. **`personal`** — the universal fallback for a first-run unlock or
   if the previously-saved engram has been deleted since you used it.
3. **`personal` (created)** — on a brand-new cortex with no engrams on
   disk yet, `personal` is created with default metadata.

This means the lock screen disappears with the engram you actually want
to see already showing, instead of always showing `personal` and then
swapping a few seconds later once your real engram catches up.

### Why not always parallel-load everything?

Earlier versions did. The problem: each engram load includes
synchronous decryption that monopolises the Node event loop, so 12
concurrent loads via `Promise.all` would stall the IPC socket for
20–30 seconds. The desktop app's first `list_nodes('personal')` call
would sit queued, freezing the lock screen on "Loading memories…" for
the full duration of background loading.

Sequential loading with an `await setImmediate()` yield between each
engram is slightly slower in raw wall time (~6s sequential vs ~5s
parallel for 12 engrams), but the lock screen reveals in ~3s instead
of ~25–30s because IPC requests interleave between loads.

## Reading the status bar

While background loads are in flight you'll see, in the status bar at
the bottom of the app:

```
Loading 7 more engrams…
```

The number ticks down with each completed load. When all engrams have
loaded, the message disappears.

The status bar also shows **overlay engine pills** when non-deterministic layers are active:

- **Turquoise pill** — the Local LLM (Graphnosis Local Layer) is enabled and at least one capability toggle is on.
- **Purple pill** — the Graphnosis Neural Network (.GNN) is enabled and has computed edges.

These pills are always visible when the respective engine is on, not just during loading — they act as a persistent reminder that overlay engines are running.

## Reading the engram picker

Click the engram name in the topbar to open the dropdown. The list shows
**every engram in your cortex immediately on unlock**, in alphabetical
order:

- **Bold / normal weight** — the engram is loaded and selectable.
- **Greyed out, italic, "not allowed" cursor** — the engram exists on
  disk but hasn't finished decrypting into memory yet. Clicking it does
  nothing; the picker won't switch.
- **✓ checkmark** — the engram currently active.

As each engram finishes loading, its row **updates immediately** — the
greyed styling drops and the engram becomes selectable as soon as its
own load completes, without waiting for the rest. Positions stay
alphabetical the whole time — engrams don't jump around as they load.

If you click an engram that's still pending, the picker silently rejects
the click and stays open so you can pick another. There's no error
flash; the visual greying is the signal.

## What if I deleted the engram I last had open?

If `localStorage` remembers `book-notes` but `book-notes.gai` no longer
exists on disk, the sidecar falls back to `personal` silently (rather
than creating a fresh empty `book-notes` to match the stale preference).

On the next unlock after you select a different engram, the new choice
becomes the persisted default.

## Power-user override: `GRAPHNOSIS_DEFAULT_GRAPH`

If you launch the sidecar standalone (for MCP wiring into Claude
Desktop, for example) you can set `GRAPHNOSIS_DEFAULT_GRAPH` directly
in the environment to override the default. This is the same variable
the desktop app sets from `localStorage` at unlock time. See [Environment
variables](/reference/environment-variables/) for the full list.

## Related

[AI Access Controls](/guides/ai-access-controls/) — what an AI client

  can actually read once your engrams are loaded.
[Graphs and tiers](/guides/graphs-and-tiers/) — sensitivity tiers per

  engram.
[MCP Tools](/reference/mcp-tools/) — the toolset AI clients see once

  the cortex is up.
