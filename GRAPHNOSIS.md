# Graphnosis memory — instructions for AI assistants

v1.11.0

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

## Formulate the query well

Recall quality depends heavily on how you phrase the query. The user's
utterance is often not the best query string. Before calling `recall`,
`remind`, or any other search tool, do this:

**Strip the framing.** "Remind me where Nelu lived" is a request, not a
query. Pass only the semantic content: `unde a locuit Nelu` or
`Nelu lived where`. Drop "remind me", "what did I say about", "do you
know if", and equivalent phrasings in any language.

**Match the language the memory was stored in.** The lexical index does not
bridge languages. If the user asks in one language but may have stored the
note in another, you need to query in both.

You usually don't know upfront which language the memory is in. Use this
heuristic:

  1. **If you've seen the user's memory in this session**, query in the
     language(s) you saw. The audit footer of past recalls reveals the
     content language.
  2. **If you don't know**, query in the user's current input language AND
     in any other language the user has used with you before in this
     conversation. When in genuine doubt, include English as a fallback —
     it's the most common second language for technical / international
     users.
  3. **If a recall returns zero results**, retry once with the query
     translated into one or two other plausible languages before telling
     the user nothing was found. Many "zero result" cases are language
     mismatches, not missing memory.

Examples (the principle is the same regardless of language pair):

  User (English) asks about a note stored in Spanish:
    First try:  `Nelu live home location vive casa ubicación dónde`

  User (Japanese) asks about a note stored in English:
    First try:  `プロジェクト marketing project マーケティング 提案`

  User (Arabic) asks about a note stored in French:
    First try:  `مشروع تسويق projet marketing proposition`

Translate the key content words; keep proper nouns (names, places,
projects) in their original form and exact spelling — don't transliterate
"Nelu" to "ネル" or "نيلو". The lexical index matches them as-is.

**Add 1–2 synonyms in the same language.** TF-IDF has no semantic awareness.
"locuit" won't match "trăit"; "live" won't match "reside". Add the obvious
near-synonyms inline.

**Keep the query short and dense.** 3–8 content words is the sweet spot.
Avoid filler ("the", "a", "is"), avoid full natural-language questions,
avoid punctuation. The query is fed to a lexical index and an embedding
model — both prefer compact intent over complete sentences.

**Anchor on proper nouns.** Names of people, places, projects, and concrete
identifiers (URLs, file names, dates) are the strongest signal. If the user
mentions one, always include it verbatim — exact spelling and capitalization.

This costs you nothing and dramatically improves recall, especially for
small or cross-language engrams. The user does not need to do this — you do.

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

**Preserve the user's language when saving.** Don't translate the note into
English "for safekeeping" — save it in whatever language the user used.
The recall side compensates for language mismatches; the storage side
should not destroy the original phrasing. If the user mixes languages in
one note, keep the mix.

## Keep the memory clean

Graphnosis memory is for **facts and verified information** — decisions actually
made, things actually true, work that actually happened. It is not a scratchpad
for speculation.

- Save what is settled and correct. Don't record guesses, unverified claims, or
  half-formed ideas as if they were fact; if something is uncertain, leave it
  out or note the uncertainty plainly.
- Don't save ephemeral chatter, jokes, or hypotheticals — memory is not a chat log.
- To FIX, UPDATE, or ADD DETAIL to something already in memory, use `edit`, never a second `remember` —
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

Graphnosis exposes **35 MCP tools** across 9 functional groups. Use the right
tool for the user's intent — the tool you pick is a soft signal to the user
and shapes the audit footer.

**Core memory** (use these for most everyday turns):

- `recall` — semantic search across the user's engrams. Returns a ready-to-read context block. **Escalation policy**: if `recall` returns 0–3 nodes (or returns nodes that don't actually answer the question), DO NOT say "no results". Call `dig_deeper` with the same query first. Most "nothing found" cases are language / phrasing mismatches that `dig_deeper`'s expansion catches. **Tool loading note**: `dig_deeper` is in the same tool group — if your client uses deferred schema loading, load `dig_deeper` via `tool_search` before the first `recall` call so the escalation path is ready.
- `remind` — alias for `recall`, framed as "remind me about…". Same input + same results. Same escalation policy: thin result → escalate to `dig_deeper` before telling the user the memory isn't there.
- `dig_deeper` — the "look harder" escalation. Use when `recall` returned thin results, when the user's query references a document by name (filename, paper, project), or when the question spans multiple engrams. Internally orchestrates content recall + source-filename expansion + cross-engram entity hop. Returns more nodes with a full provenance breakdown. If results look off, the meta-instruction tells you to flag it to the user — that's the developer-feedback channel. **💡 source hint**: if any recall or dig_deeper response contains a "💡 The query entities also match source-file names…" line with sourceIds, **STOP — you MUST call `recall_source` with those IDs before composing your answer**. That hint means a whole document is relevant; the fragment you received is not sufficient.
- `remember` — save a new memory. Pass `target_engram` whenever the note has a topical home (e.g. "Book Notes", "Work decisions").
- `forget` — surgically soft-delete one or more specific memory **nodes** (not a whole source). **Always call `recall_structured` first**, then pass the result as `items: [{nodeId, preview}]` — `preview` is the first ~120 chars of `node.text`. Most MCP clients show the request payload to the user in a consent prompt; without the preview, the user sees only opaque IDs and is essentially clicking blind. The legacy `nodeIds: [...]` shape still works but the response will nag you to switch. Never pass a `sourceId` — that field does not exist. To remove an entire ingested file, URL, or clip, direct the user to the Sources page in the app — AI clients cannot delete whole sources.
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
- `recall_source` — full content of one source, in ingestion order (use when `recall` fragments a structured document, or when a 💡 hint in any recall response named specific sourceIds — in that case, **do not respond until you have called this tool**).
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

- `edit` — propose a change to existing memory as a structured diff. Covers three cases: **CORRECTION** ("actually it was September, not August"), **UPDATE** ("my plans changed — update my Q3 milestones to…"), and **APPEND/ADD DETAIL** ("add these items to my project plan"). **Never use `remember` to modify something — that creates duplicate conflicting nodes.** Always `edit`.

**Non-deterministic** (require the optional Local LLM running on the user's machine):

- `develop` — strategic plan grounded in the user's memory.
- `predict` — risks + opportunities for an action the user is about to take.
- `insights` — patterns / gaps / opportunities a background LLM loop surfaced.
- `gnn_neighbors` — nodes the Neural Network predicts are related to a query.
- `llm_query` — synthesised answer from recall, computed locally. **Prefer this over raw `recall` when the question requires assembling facts from multiple nodes or engrams into a single coherent answer** — e.g. "summarise everything I know about X", "compare my notes on A vs B", or "what's the pattern across my decisions?". For point-lookup questions ("what did I say about X?"), plain `recall` is faster and sufficient.
- `llm_distill` — extract discrete facts from arbitrary text, ready for `ingest_batch`.

## The local LLM — what it does, what it does not

Graphnosis can use a **local LLM** (Ollama, running on the user's machine) to
make several features smarter. The LLM never sees anything outside the
device; if the user hasn't installed Ollama, all of these features simply
stay off.

The user controls each capability independently in
**Graphnosis → Go Non-Deterministic → Local LLM**:

| Capability | What it does | Touches the graph? |
|---|---|---|
| **Recall enrichment** | Rewrites your query at recall time (synonyms, cross-language, strip framing) | **No** — purely retrieval |
| **Correction parsing** | Upgrades `correct` to author multi-memory diffs | Only after the user approves the diff |
| **Distillation** | Powers `llm_distill` — extracts structured facts from text | No — returns text to you |
| **Insights / predictions** | Powers `insights`, `develop`, `predict`, `llm_query` | Writes to the LLM overlay, not the canonical engram |
| **Edge prediction** | Background loop proposes connections between co-recalled nodes | Writes to the `.gll` overlay, never to `.gai` |

What follows from this for AI clients:

- **Don't assume the local LLM is on.** When you call `insights`, `develop`,
  `predict`, `llm_query`, or `llm_distill` and get "Local LLM unavailable",
  it's because the user has either disabled the master switch or that specific
  capability. Surface the situation plainly and suggest the relevant toggle
  path; never pretend the feature ran.
- **Recall enrichment, when on, is invisible to you.** Your query gets
  rewritten server-side before it hits the index. A short `_enriched: "..." → "..."_`
  footer appears in the recall response so you can see what actually ran.
  Treat it as informational; don't try to undo it.
- **Predictions and inferred edges live in overlays, not in canonical memory.**
  When a future version surfaces them in recall, they will carry a visible
  "from LLM inference" / "from neural prediction" badge. The user's
  attested memory in `.gai` is never mutated by the LLM.

## Layered memory: `.gai`, `.gnn`, `.gll`

Graphnosis splits a user's memory into three physical layers, each with a
different determinism contract. Treat them differently in your responses.

| Layer | File | Contains | Mutable by |
|---|---|---|---|
| Canonical | `.gai` | Every memory the user attested (or that you saved on their behalf via `remember`) | Only the user, via explicit corrections |
| Neural network overlay | `.gnn` | Predicted edges from a local graph neural network | The neural network's training pass; user discards via UI |
| Local LLM overlay | `.gll` | Predicted edges + synthesized assertions from the local LLM | The LLM's inference loops; user discards via UI |

The LLM cannot mutate `.gai`. The neural network cannot mutate `.gai`. The
only path to a change in attested memory is an `edit` diff the user reviews
and approves. This is structural, not procedural — different files, different
write privileges.

### How recall surfaces the layers

When you call `recall`, `remind`, `cross_search`, or `compare_engrams`, the
response is structured as follows:

#### 1. The attested subgraph

One `=== KNOWLEDGE SUBGRAPH ===` block per engram, drawn purely from `.gai`.
This is the authoritative answer — byte-deterministic for the same query +
cortex state.

The subgraph uses this format:

```
## Engram Display Name
=== KNOWLEDGE SUBGRAPH (N nodes, M edges) ===

--- SESSION SUMMARIES ---
[n0|summary|0.91|session:abc123|date:2026-05-20] Session title
  claims: atomic fact one | atomic fact two | atomic fact three

--- NODES ---
[n1|fact|0.95|src:source-label|date:2026-05-20] Node text here
[n2|concept|0.82|date:2026-05-18] Another node

--- DIRECTED ---
n1 -[depends-on:0.9]-> n2

--- UNDIRECTED ---
n1 ~[related-to:0.7]~ n2
```

**Node format:** `[shortId|nodeType|score|tags] content`
- `nodeType`: `fact`, `concept`, `entity`, `event`, `definition`, `claim`,
  `data-point`, `person`, `document`, `section`, `summary`
- `score`: relevance from 0.00 to 1.00
- `tags`: optional `src:{label}` and/or `date:{YYYY-MM-DD}`

**Session summaries** (`--- SESSION SUMMARIES ---`): compressed context from
earlier sessions. The `claims:` line lists atomic facts pipe-separated.
Treat them as high-confidence attested context — they are distilled from
sessions you've already had.

**Edges:**
- Directed: `n1 -[edgeType:weight]-> n2` (causes, depends-on, supersedes…)
- Undirected: `n1 ~[edgeType:weight]~ n2` (related-to, co-occurs, same-source…)

#### 2. Cross-graph connections

When recall spans multiple engrams, a `--- CROSS-GRAPH CONNECTIONS ---`
block appears after the per-engram subgraphs, showing entity overlaps:

```
--- CROSS-GRAPH CONNECTIONS ---
"EntityName" → Engram A: "preview from engram A" | Engram B: "preview from engram B"
```

This is supplementary context for cross-domain questions — same entity,
different engrams. Treat it as attested; it is derived from `.gai` content.

#### 3. Audit footer and footnotes

```
---
Attached N memory node(s) / T tokens across G graph(s). Per-graph (tier · nodes · tokens): personal · 5n · 350t.
_anchored N node(s) on entities: PersonName, ProjectName_
_GNN expanded recall by N node(s) at ≥65% confidence_
_enriched: "original query" → "rewritten query"_
```

- `_anchored …_` — entity anchoring pinned those nodes as high-confidence seeds.
- `_GNN expanded …_` — the neural network widened the candidate set; those extra nodes have a GNN basis.
- `_enriched …_` — the local LLM rewrote the query (only when Recall enrichment is on). Informational — the search that ran used the rewritten form.

#### 4. The inferred layer

When overlay engines are on and their data intersects the result, a single
block is appended after the audit footer:

```
--- INFERRED LAYER (overlays — NOT attested memory) ---
### Engram name
  [gll·assertion 78%] Synthesized fact text from [node-id, …]
  [gll·edge 65%] node-a —[elaborates]→ node-b
  [gnn·edge 81%] node-c —→ node-d
```

What you should do with the inferred layer:

- **Cite it as a prediction, not a fact.** "Based on a local-LLM inference
  with ~78% confidence" — never "you said X" when X is from a `[gll]` row.
- **Prefer attested content when there's a conflict.** If `.gai` says the
  user lives in Bucharest and a `[gll·assertion]` infers Cluj, the canonical
  memory wins. Mention the discrepancy and offer `edit` if appropriate.
- **Don't `remember` an inferred row.** That promotes a probabilistic
  prediction into attested memory — exactly the failure mode the overlay
  architecture exists to prevent. If the user confirms the inference is
  correct, save the user's confirmation as a new attested memory via `remember`.
- **Don't try to `forget` an inferred row.** `forget` operates on `.gai`
  node ids only. To wipe overlay content, the user uses the overlay
  controls in Non-Deterministic Aid.

If the overlay block is absent, either no overlay data intersected the
result, or the user has the relevant capability off. Answer from the
attested subgraph alone.

#### 5. dig_deeper response shape

`dig_deeper` extends the standard subgraph with two extra labelled sections
and italic provenance bullets:

```
[Stage 1: standard recall subgraph, same shape as recall]

## DIG_DEEPER — Source-filename expansion
### Engram Name (additional chunks from matched source filenames)
- Chunk text from matched source

## DIG_DEEPER — Cross-engram entity hop
_Pulled via shared entities: EntityA, EntityB_
### Engram Name
- Node text reached via entity overlap
```

Then provenance bullets (italic Markdown, not a code block):

_• Content match (recall): N nodes, avg score S_
_• Source-filename expansion: N nodes from M source(s): name-a.md, …_
_• Cross-engram entity hop: N nodes via M shared entities across K engram(s)_

If indirect stages dominated (>60% of nodes), a heads-up follows:

⚠️ _Heads-up for the user: the direct content match returned few nodes; most
of this result came from indirect expansion. Flag this to the user so they
can confirm relevance or rephrase._

When you see the ⚠️, surface it — don't silently present an expansion-heavy
result as if it were a confident direct match.

### Autonomous edge prediction

When the user has the **edgePrediction** capability enabled (opt-in, off by
default), a background loop runs once an hour: it picks one engram, finds
pairs of semantically-similar nodes that don't already have an edge
between them, and asks the local LLM whether those pairs are actually
related. Pairs the LLM confirms — with a relationship label and a confidence
score — get written to the `.gll` overlay as predicted edges.

The user reviews these in the **Graphnosis Local Layer (.GLL)** section of
the **Non-Deterministic Aid** tab. Accept removes from the review queue (and
is the path that will promote to canonical `.gai` in a future iteration).
Reject deletes from the overlay permanently.

You won't usually need to interact with this loop directly — it surfaces
through the normal recall path's `[gll·edge N%]` rows in the inferred-layer
block. But if a user asks "what's the AI suggesting about my memory?", the
answer lives in that review queue, and predictions become visible to recall
the moment they're written.

## When Graphnosis is not connected

The tools work only while the Graphnosis app is open and the user's cortex is
unlocked. If they are unavailable, carry on as normal — but tell the user
Graphnosis is not connected, and that they can open the app, unlock their
cortex, and then ask you to redo the last step so it gets recalled or saved.
