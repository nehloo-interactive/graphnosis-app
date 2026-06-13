---
title: Memory Across AI Clients
description: Real-world workflows where one Graphnosis cortex keeps the same memory consistent across Claude Desktop, Claude Code, Cursor, and any other MCP client.
sidebar:
  order: 0
---

The whole point of a local, encrypted second cortex isn't "save things." It's "save once, retrieve from any AI client or any device, forever, without re-uploading anything." Below are concrete workflows people use Graphnosis for. Each one is just a sketch — pick whichever AI clients and devices you actually use; the memory is the same in all of them.

A reminder of the core loop:

> Save in client A → Update or expand in client B → Recall in client C — all reading from the same encrypted cortex on your Mac, no re-ingest, no copy-paste, no cloud history.

---

## 1. Researching a topic over many weeks

You're going deep on a subject — a technology, a country, a medical condition, a historical period, a piece of legislation. You read across articles, papers, podcasts, and threads.

A realistic flow:

- **Tuesday, Claude Desktop:** You paste an article into the chat and ask the AI to summarize the key points and save them to a `research` engram via `remember`.
- **Wednesday, Cursor:** You're skimming a related GitHub repo. You ask Cursor to compare what the repo does to your earlier notes — Graphnosis recalls them and the AI cites them inline.
- **Friday, Claude Code:** You're writing a short report about what you learned. You ask "what are my top three takeaways from the research?" — the AI pulls from the same engram and drafts the report from your own notes.

You never re-read the original articles. The summaries stay yours, locally, encrypted, and consistent across every AI you use.

---

## 2. Learning a new skill or technology

You're picking up a new framework, language, instrument, or craft. You take notes in different sessions over weeks or months.

A realistic flow:

- **Reading a book chapter** in Claude Desktop — ask the AI to summarize the chapter and save it to a `learning-rust` (or whatever) engram.
- **Watching a tutorial video** — paste the transcript into a different AI client, ask for a structured summary, save it to the same engram.
- **Working on practice exercises** in Cursor — ask "what does my engram say about lifetimes? Compare to what I'm trying here." The AI recalls your own learning notes and grounds its explanation in concepts you've already covered.

Three months later, your "engram" is a personal textbook of everything you've actually learned — searchable by any AI, written in the way you understand it best.

---

## 3. A long-running side project

You're building something on the side — an app, a book, a band, a course, a business idea. Progress is spread across many AI conversations over months.

A realistic flow:

- **Saturday morning, Claude Desktop:** Brainstorm features for the project. Save the brainstorm to a `side-project` engram.
- **Saturday afternoon, Cursor:** Start coding. Ask the AI what features were prioritized — it recalls the brainstorm and quotes you back to yourself.
- **Two weeks later, Claude Code:** Pick up where you left off. Ask "what did I decide about the auth flow?" — your prior decisions are right there.
- **A month later, Claude Desktop:** Draft a launch announcement. Ask the AI to summarize what the project does based on every note in the engram — it pulls a coherent picture from notes spread across dozens of sessions.

No project tracker, no Notion page, no "where did I leave off?" friction. Your memory is the substrate the AI works on, not your file system or your browser tabs.

---

## 4. Career and job search

You're job-hunting, switching careers, or maintaining a network. Information comes in across many small conversations and you want to keep it organized without manually maintaining a spreadsheet.

A realistic flow:

- **Wednesday, Claude Desktop:** After a phone screen, paste the recruiter's notes and the company description. Ask the AI to summarize and save to a `job-search` engram.
- **Friday, a different AI client:** Before a follow-up interview, ask "what do I know about Company X? What questions did the recruiter say to expect?" — your own pre-interview notes come back.
- **Two weeks later, after the offer:** Ask the AI to summarize everything you saved about Company X to inform the offer-acceptance decision.

You arrive at every conversation with a recruiter or interviewer already remembering everything you've decided or noticed, even if the last interaction was a month ago.

---

## 5. Trip planning, then memory-keeping during the trip

You're planning a multi-week trip and want to keep destination research, contacts, and on-the-ground notes in one place that travels with you.

A realistic flow:

- **Three months before the trip, Claude Desktop:** Save your itinerary, the list of cities, contacts of friends in each, and restaurant recommendations to a `travel-japan-2027` (or whatever) engram.
- **A week before the trip, Cursor or Claude Code:** Ask the AI to draft a packing list based on the destinations and time of year — Graphnosis recalls the itinerary, the AI builds the list from it.
- **During the trip, mobile-via-Claude-Desktop:** Save notes about restaurants you actually visited, things you learned, recommendations for next time.
- **After the trip:** Ask the AI to draft a trip recap or a "tips for friends going to Japan" doc — it pulls the entire arc of the trip from your own notes.

The trip becomes a long, structured memory you can hand to friends, your future self, or your future AI clients — instead of evaporating across a dozen chat sessions and a notes app you'll never reopen.

---

## 6. Save from your phone, recall on your laptop

Memory doesn't only move between AI clients — it moves between *devices*. With a personal server running, you capture something on your phone and it's waiting on your laptop, because both are reading from the one cortex on the server.

A realistic flow:

- **Tuesday, on the train, phone:** Open your cortex in the phone's browser ([browser access](/getting-started/mobile/) over Tailscale). You read an article, jot a few takeaways, and save them to your `research` engram — straight into the same cortex your laptop uses.
- **Tuesday, also on the phone, Claude for iOS:** Same cortex, this time via the [MCP bridge](/getting-started/mobile/). You ask "what did I already note about this topic?" and your AI recalls the notes you just saved, plus older ones.
- **Wednesday, back at your desk, Claude Code:** "Pull my research notes from this week into an outline." Everything you captured on the move is right there — no export, no sync app, no copy-paste. The phone was just a remote screen onto the same encrypted cortex.

The cortex never lived on the phone. It stayed encrypted on the server; your phone reached it over Tailscale, and the laptop reads the same store. One memory, every device.

---

## 7. The auto-growing inbox — connectors + cross-client recall

The first five workflows are about you saving things deliberately. This sixth is the inverse — **memory that lands in your cortex without you doing anything**, then becomes recallable across every AI client the same way.

A realistic flow:

- **Monday:** Set up the **Slack connector** in Settings → Connectors → paste a Slack User Token from a custom app you created in your workspace → target engram: `work`. Set it once and forget it. Every starred Slack message you make from now on lands in `work` within 15 minutes.
- **Tuesday:** Same thing for the **GitHub connector** — paste a PAT, watch the repos you care about, route to `code`. PR descriptions, issue threads, releases all flow in.
- **Tuesday afternoon, Claude Desktop:** "What did we decide about the auth flow last week?" — your AI recalls the starred Slack thread where the decision was made, plus the related GitHub PR comment, without you ever pasting anything.
- **Thursday, on your phone, Claude for iOS:** Using the [mobile bridge](/getting-started/mobile/), same query, same answer — your `work` engram is reachable from anywhere over Tailscale.
- **Friday, back in Cursor on the laptop:** Ask "draft a status update for the team based on what landed this week." Your AI pulls the week's connector-ingested context across Slack + GitHub + your manual notes.

You stopped curating. The cortex curates itself from the tools you already use, and every AI client you connect to it sees the same picture. Cross-device, cross-client, cross-source — one consistent memory.

Setup walkthroughs for each connector: [Auto-ingest from your tools](/guides/connectors/).

---

## What these workflows have in common

Four things show up in every example:

1. **You don't pick "the right AI client" up front.** You use whichever client is in front of you at the moment — desktop, mobile, IDE. The memory is independent of any single AI.
2. **You don't re-upload anything.** Graphnosis stores the summary once; every AI client recalls just the slice relevant to the current prompt. Smaller context windows, faster responses, lower token costs.
3. **Your data doesn't leave your machine.** The cortex is encrypted on your Mac. The AI client only ever sees the few hundred tokens that matter for the current prompt — not your whole archive, and never the underlying files. Mobile clients reach you over a bearer-authenticated local-network bridge or Tailscale — still your network, still your devices.
4. **The cortex grows whether you're paying attention or not.** Manual saves (workflows 1–5) plus passive connector ingest (workflow 6) compound. After a few weeks, ask your AI anything about your work and the relevant context is just there.

If you find yourself thinking "I wish my AI remembered that thing I told it last week" — that's the thing Graphnosis exists to solve. Pick one of the workflows above, swap the topic for whatever you actually care about, and try it for a few days.

---

## A tip on engram naming

When asking your AI client to save into a specific engram, use a name that's specific enough to make sense to you in six months but generic enough to group related notes:

- ✅ `learning-rust`, `book-deep-work`, `trip-portugal-2027`, `client-acme-corp`
- ⚠️ `notes` (too vague — you'll have one giant engram), `today`, `misc`

You can always rename via the Settings → Engrams panel later. And if your AI client guesses a name that doesn't exist yet (or is close to something that does), Graphnosis shows you a confirmation banner before creating a new engram — no AI ever creates engrams without your okay.

---

## Related

[A GRAPHNOSIS.md for Your AI](/getting-started/graphnosis-md/) — the drop-in instructions file that makes any AI actually use Graphnosis.

[Connect Your AI](/getting-started/connect-ai/) — wire each client into the same cortex.

[Auto-ingest from Your Tools](/guides/connectors/) — passive workflow that compounds across sessions.

[Graphs & Sensitivity Tiers](/guides/graphs-and-tiers/) — keep work, personal, and sensitive material separate.


---

## Explore by use case

→ [**Personal**](/for/personal) — one cortex, every AI client, no silos  
→ [**Team**](/for/team) — shared job memory with scoped access per teammate
