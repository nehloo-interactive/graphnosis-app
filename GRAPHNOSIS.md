# Graphnosis memory — instructions for AI assistants

v0.10.0

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

## Consent before recall

`public` and `personal` engrams are served without an extra prompt — the user
installing Graphnosis and adding it to their AI client's MCP config is already
two affirmative, informed actions for routine personal data.

`sensitive` engrams (health, financial, biometric — GDPR Art. 9 special
category) are gated by an explicit, one-click consent the user gives **in the
Graphnosis app itself** (a modal pops with Allow / Deny / Allow-for-1h /
Allow-for-today). Most of the time you will simply receive the recall results
once they click Allow. You don't need to do anything special.

A small number of headless setups (sidecar over SSH, in CI, in Docker without a
GUI) still use the legacy phrase-typing fallback. In those cases — and only
then — any tool that returns memory data (`recall`, `remind`,
`recall_structured`, `recall_with_citations`, `compare_engrams`,
`cross_search`, `llm_query`, and others) may return a "⚠️ GRAPHNOSIS CONSENT
REQUIRED" notice instead of data. If you see that notice:

1. **Present it in full** — do not summarize, shorten, or paraphrase it.
2. **Tell the user** to open the Graphnosis app → Settings → AI → Consent Phrases.
3. **Wait for the user to type the phrase.** Do not suggest, guess, or autocomplete it.
4. **Call `confirm_data_access`** with exactly what they typed and the tier.
5. **Only after a successful response**, retry the original recall.

If the user types SKIP, acknowledge and do NOT retry the recall. Do not supply
the phrase yourself. The protocol — modal or phrase — exists to ensure a
**human, not an AI**, authorizes access to special-category data.

Federated recall ("just search everything") automatically excludes any
sensitive engram you don't have consent for, so the gate only fires when you
explicitly named a sensitive engram via `only_engrams` or `target_engram`.

## The tools

Graphnosis exposes **34 MCP tools** across 9 functional groups. Use the right
tool for the user's intent — the tool you pick is a soft signal to the user
and shapes the audit footer.

**Core memory** (use these for most everyday turns):

- `recall` — semantic search across the user's engrams. Returns a ready-to-read context block.
- `remind` — alias for `recall`, framed as "remind me about…". Same input + same results.
- `remember` — save a new memory. Pass `target_engram` whenever the note has a topical home (e.g. "Book Notes", "Work decisions").
- `forget` — surgically soft-delete one or more specific memory **nodes** (not a whole source). Takes `nodeIds` from `recall_structured` results. **Always call `recall_structured` first** to find and confirm the exact nodes before calling `forget`. Never pass a `sourceId` — that field does not exist. To remove an entire ingested file, URL, or clip, direct the user to the Sources page in the app — AI clients cannot delete whole sources.
- `apply` — commits a correction the user has already approved. The Graphnosis app normally drives this; AI clients rarely call it directly.
- `stats` — engram inventory + node counts. Useful before picking a `target_engram` and for debugging "where did my notes go?"
- `vitality` — 0–100 score of how alive and well-connected the cortex is.

**Engram discovery** (use before routing a save, or when the user asks "what do I have?"):

- `list_engrams` — every engram with names, tiers, source counts.
- `suggest_engram` — recommends the best engram for a given note (lexical match).
- `browse_engram` — lists every source inside one engram, newest first.
- `recent` — most recently ingested sources across all engrams.
- `get_engram_schema` — metadata for one engram (tier, template, display name).

**Structured recall** (use when you need machine-shaped results or finer scoping):

- `recall_structured` — `recall` but returns a JSON array of node objects.
- `recall_with_citations` — `recall` with inline source citations per fact.
- `compare_engrams` — same query against two engrams, results side-by-side.
- `cross_search` — federated `recall` over a hand-picked subset of engrams.

**Source operations** (act on a whole saved source — file, URL, clip):

- `find_source` — keyword substring search across source IDs / refs / kinds.
- `recall_source` — full content of one source, in ingestion order (use when `recall` fragments a structured document).
- `transfer_source` — move a source from one engram to another.

**Engram operations**:

- `ingest_batch` — save up to 20 notes in one call, each with its own `target_engram`.
- `engram_summary` — readable snapshot of one engram (counts + node previews).
- *(merging engrams is a user-only action in the app — no MCP tool)*

**Brain maintenance** (read-only windows into the background brain engine):

- `duplicate_pairs` — pairs the brain has flagged as near-duplicates pending the user's review.
- `healing_journal` — audit log of autonomous corrections the brain made on its own.
- `gnn_status` — is the Graphnosis Neural Network enabled, how many edges predicted, last run.
- `confirm_data_access` — headless-fallback consent confirmation (see "Consent before recall" above).

**Approximate** (similarity scans, no LLM — useful before saves / merges):

- `audit_memory` — detect near-duplicate content across engrams.
- `check_duplicate` — before `remember`, check whether something similar already exists.

**Conditional** (deterministic by default, LLM-aware when enabled):

- `correct` — propose a reviewed fix to existing memory as a structured diff. **Never use `remember` to "fix" something — that creates duplicate conflicting nodes.** Always `correct`.

**Non-deterministic** (require the optional Local LLM running on the user's machine):

- `develop` — strategic plan grounded in the user's memory.
- `predict` — risks + opportunities for an action the user is about to take.
- `insights` — patterns / gaps / opportunities a background LLM loop surfaced.
- `gnn_neighbors` — nodes the Neural Network predicts are related to a query.
- `llm_query` — synthesised answer from recall, computed locally.
- `llm_distill` — extract discrete facts from arbitrary text, ready for `ingest_batch`.

## When Graphnosis is not connected

The tools work only while the Graphnosis app is open and the user's cortex is
unlocked. If they are unavailable, carry on as normal — but tell the user
Graphnosis is not connected, and that they can open the app, unlock their
cortex, and then ask you to redo the last step so it gets recalled or saved.
