---
title: Adding Content
description: How to ingest files, web pages, and clips into your cortex.
sidebar:
  order: 1
---

Your cortex is only useful if you put things in it. Graphnosis supports several ingest methods: files, URLs, and quick clips.

## Supported file types

| Format | Extension(s) | Notes |
|--------|-------------|-------|
| PDF | `.pdf` | Parsed via pdfjs-dist in a worker thread; text + structure extracted |
| Word document | `.docx` | Text and basic structure extracted |
| Markdown | `.md`, `.mdx` | Full text; frontmatter treated as metadata |
| Plain text | `.txt` | Ingested as-is |
| HTML | `.html`, `.htm` | Main content extracted; nav/footer/scripts stripped |
| JSON | `.json` | Stringified and chunked |
| CSV | `.csv` | Rows converted to text blocks |

Binary files (images, audio, video, executables) are not supported and will be rejected at ingest.

## Add a file

**From the menu bar:** Click the Graphnosis icon → **Add File** → pick a file.

**By drag and drop:** Drag a file onto the Graphnosis menu bar icon.

**From the main window:** Open the Graphnosis window, go to your graph, and click **+ Add**.

After you pick a file, Graphnosis will:

1. Parse and extract text content.
2. Split the text into overlapping chunks (default: 512 tokens per chunk, 64-token overlap).
3. Embed each chunk locally using BGE-small-en-v1.5 (ONNX, runs in a forked child process).
4. Encrypt the chunks and embeddings and write them to `cortex.db`.
5. Create a **Source** record linking the chunks back to the original file path.

Ingestion of a large PDF (hundreds of pages) may take 10–30 seconds on Apple Silicon, longer on older Intel hardware.

## What is a Source?

A Source is a record that represents one piece of ingested content — a file, a URL, or a clip. It stores:

- The original location (path or URL)
- The ingest timestamp
- The graph it belongs to
- Chunk count and total token estimate
- A SHA-256 content hash (used for deduplication)

If you ingest the same file twice, Graphnosis detects the duplicate hash and skips it unless you force-reingest.

## Ingest a web page

Click the Graphnosis icon → **Add URL** → paste a URL.

Graphnosis fetches the page, strips boilerplate (navigation, ads, scripts), and ingests the main article body. JavaScript-heavy single-page apps may not extract well if the content isn't in the initial HTML.

## Save a clip

A **clip** is a short piece of text you paste or type directly — a quote, a decision, a note, anything that doesn't have a file.

Click the Graphnosis icon → **Add Clip** → type or paste your text → choose a graph → **Save**.

Clips are useful for:
- Capturing decisions made in a meeting
- Saving a snippet from a conversation that isn't worth a full file
- Quick notes you want to be able to recall semantically

## Large files and chunking

Files are split into chunks before embedding. The default chunk size is 512 tokens with a 64-token overlap between adjacent chunks. This overlap helps recall find content that falls near a chunk boundary.

For very large files (thousands of pages), ingest is done in a background worker so the UI stays responsive. You can see ingest progress in the Graphnosis window.

## Who added each memory? AI client attribution

Memories added by an AI client (via the `remember` MCP tool — Claude Desktop, Cursor, Claude Code, etc.) show a small turquoise badge in the Sources list:

| Badge | What it means |
|-------|---------------|
| `via claude-ai` | Claude Desktop ran `remember` |
| `via cursor` | Cursor ran `remember` |
| `via claude-code` | Claude Code ran `remember` |
| (no badge) | You added this manually — drag-drop, paste, or file picker |

The badge derives from the MCP `initialize` handshake's `clientInfo.name`. It's purely informational — there's no behavior difference; the badge just helps you audit what came from where.

**Two flavors of AI-saved memory**: the `remember` tool now accepts `kind: 'clip' | 'ai-conversation'`. AI clients use `clip` (the default) when extracting a fact from external content (a doc you shared, a search result, an article). They use `ai-conversation` when saving a turn or summary of the CURRENT conversation — so you can tell *"Claude paraphrased me"* from *"Claude saw this in a doc I shared"*. Both appear in the Sources list; the source ref makes the kind explicit.

**Correction attribution**: when an AI client applies a correction via the `apply` MCP tool (after you approved a `correct` proposal), the op-log records `correctedBy: <client name>` on every node edit/supersede/delete. The Activity view surfaces this for full audit.

## Auto-relink: how new memories connect to old ones

After every ingest, Graphnosis runs a quick **auto-relink** pass over the affected engram. It compares the entities mentioned in the newly-added nodes (people, places, projects, concepts) against the entities in every existing node and creates "related-to" edges wherever there's meaningful overlap.

This is why you'll see lines like this in the dev terminal during normal use:

```
[host] auto-relink wove 44 edges across 373 active nodes in personal
```

That's Graphnosis discovering, on its own, that a new note you just dropped in has 44 cross-references to memories you already had. Without this pass, each new file would be an island; with it, your engram graph genuinely gets denser the more you put in.

The pass is throttled and capped (`autoRelinkMaxNodes` in Settings, default 5,000 active nodes) so it stays fast even as graphs grow. For very large engrams that exceed the cap, you'll see `auto-relink skipped: active node count > maxNodes` — recall and search still work; only the cross-doc edge creation is paused.

## Content caching: why it matters for recovery

When you ingest a file, the raw bytes are also cached in your cortex (encrypted, in `content/`) — by default for any source up to 512MB. This is the difference between:

- **Cache hit**: if you later move/delete the original file, or the `.gai` file is somehow damaged, you can rebuild from cache without ever touching the original source again. Fast, automatic, no user action beyond clicking "Recover" in the app.
- **Cache miss** (e.g. you raised the cap, or disabled caching): recovery only works if the original file is still at the exact path you ingested it from. If it's moved, the source shows up as `file-missing` in the Recovery panel.

You can change the cache mode and per-source size limit in **Settings → Content Cache** if you want to trade disk space for recovery flexibility. The default (`all` mode, 512MB cap) covers most practical sources including large reference manuals.

There is no hard file size limit, but files over ~50 MB of raw text may take several minutes to ingest.

## Reingest and update

If a file you've ingested has changed, you can reingest it from the Source detail view. The old chunks are replaced with fresh ones from the updated content. The Source's `updated_at` timestamp is updated accordingly.

## Filtering sources

The Sources pane has a **Filter sources…** search bar at the top. Typing any text immediately hides sources that don't match — by filename, URL, or clip snippet. Engram headings collapse automatically when none of their sources match, so the list stays clean.

The filter is session-only: it resets when you close the app, and it never hides anything permanently. Clear the field to restore the full list.

## Moving a source to another engram

Sometimes a source ends up in the wrong engram. You can move it without reingesting.

1. Hover the source row in the **Sources** pane.
2. Click **Move to…** — a picker appears inline.
3. Choose the destination engram from the dropdown, or select **New Engram…** to create one on the spot.
   - If you choose **New Engram…**, type a display name in the field that appears. Graphnosis will generate a URL-safe graph ID automatically and create the engram before moving the source.
4. Click **Move**. The source disappears from the current engram's list and appears in the destination.

The move is non-destructive: all chunks, embeddings, and the content cache entry travel with the source. Nothing is reprocessed. AI recall from the destination engram will include the source on the next call, subject to that engram's sensitivity tier.

## Removing a source

Open the Source in the Graphnosis window and click **Remove**. This deletes all associated chunks and embeddings from the cortex. The original file on disk is not touched.
