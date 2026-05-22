# Graphnosis memory — instructions for AI assistants

v0.9.0

This project uses **Graphnosis** as its long-term memory: a local, encrypted
memory store the user owns and controls, reached through MCP tools. Treat
Graphnosis as the source of truth for anything that should outlive this
conversation.

## Recall before you answer

For any question that leans on earlier context — a past decision, the user's
preferences, prior work, "what did we say about X?" — call `recall` (or
`remind`) **first**, before you answer. Do this even when your own conversation
history looks empty: Graphnosis is the authoritative store, and it persists
across sessions and across AI clients. Prefer recalled memory over guessing.

## Remember — proactively, in the user's words

Whenever the conversation produces something worth keeping, call `remember` to
save it. Don't wait to be asked. Save, in particular:

- **Decisions** — what was decided, and the one-line reason why.
- **To-dos and follow-ups** — action items, things deferred, "we should later…".
- **Drafts** — meaningful drafts (messages, designs, copy, plans) worth returning to.
- **Open questions** — questions you raised that are still unanswered, and the
  user's questions that still need a follow-up.
- **Durable facts** — new, lasting facts about the user, the project, or the work.

Write each as a short, self-contained note, in the user's own words where you
can. Route topic-specific notes to the right engram with `target_engram`. When
you are unsure which engram fits, either ask the user, or call `stats` to see
the existing engrams and pick the one that best matches the note.

## Keep the memory clean

Graphnosis memory is for **facts and verified information** — decisions actually
made, things actually true, work that actually happened. It is not a scratchpad
for speculation.

- Save what is settled and correct. Don't record guesses, unverified claims, or
  half-formed ideas as if they were fact; if something is uncertain, leave it
  out or note the uncertainty plainly.
- Don't save ephemeral chatter, jokes, or hypotheticals — memory is not a chat log.
- To FIX something already in memory, use `correct`, never a second `remember` —
  a second `remember` only creates a conflicting duplicate.
- Don't save anything the user clearly would not want kept. If unsure, ask.

## Mind sensitivity

Every engram carries a sensitivity tier — **public**, **personal**, or
**sensitive** — that governs how much of it is ever exposed to an AI.

- When you save something private — credentials, health, finances, anything the
  user would not want broadly shared — route it to a personal or sensitive
  engram, or ask the user which engram to use. Never drop sensitive information
  into a public engram.
- Recall is tier-limited: a sensitive engram may return little or nothing to
  you. Treat what you recall as possibly partial — don't assume you can see
  everything the user has stored.

## The tools

Core memory tools:

- `recall` / `remind` — search the memory.
- `remember` — save a new memory.
- `correct` — propose a reviewed fix to an existing memory.
- `forget` — remove a whole source.
- `stats` — list the engrams and what they hold; useful for choosing a `target_engram`.

`apply` commits a correction the user has already reviewed — the Graphnosis app
normally drives it, so you rarely call it directly. Graphnosis also offers
optional analysis tools — `develop`, `predict`, `insights`, and `vitality` — for
strategic planning and memory health; reach for those only when the user asks.

## When Graphnosis is not connected

The tools work only while the Graphnosis app is open and the user's Cortex is
unlocked. If they are unavailable, carry on as normal — but tell the user
Graphnosis is not connected, and that they can open the app, unlock their
Cortex, and then ask you to redo the last step so it gets recalled or saved.
