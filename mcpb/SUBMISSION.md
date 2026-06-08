# Graphnosis — Anthropic Connectors Directory submission materials

Submission URL: https://clau.de/desktop-extention-submission  (note Anthropic's typo)

---

## Tagline (≤80 chars)

Your local, encrypted personal knowledge graph — recalled by any AI client.

---

## Short description (≤200 chars)

Graphnosis gives any AI client persistent, encrypted memory that lives entirely on your device. Save notes, decisions, and files; recall them semantically across sessions — privately, without cloud sync.

---

## Long description

Graphnosis is a privacy-first personal memory system that runs entirely on your device. It stores your notes, decisions, projects, files, and conversations in a local encrypted graph, then makes that knowledge available to any AI client via MCP — so your AI always has context about your life and work, without any data leaving your machine.

Every memory is encrypted at rest (libsodium XChaCha20-Poly1305, Argon2id key derivation) with a passphrase you control. Recall is deterministic and auditable — identical queries return identical results. Sensitive memories are gated behind an in-app consent modal before any AI client can read them.

The 47 MCP tools cover the full memory lifecycle: save a note, recall by semantic search, correct a stored fact, explore your knowledge graph, train reusable SOPs (skills + goals), and run multi-step procedures grounded in your personal context.

**What makes Graphnosis different:**
- Your graph stays on your device — Graphnosis has no servers. Recalled content is subject to your AI client's privacy policy.
- Sensitivity tiers: public / personal / sensitive, with per-tier consent gates
- Federated multi-graph: separate engrams for work, personal, projects, and more
- Deterministic recall with a full audit footer on every response
- Skills engine: store SOPs as graph structures, walk them step-by-step, resume across sessions
- Local LLM integration (Ollama): corrections, strategic planning, and insights run fully on-device

---

## Categories / tags

memory, knowledge-graph, privacy, local-ai, notes, recall, productivity, personal-ai

---

## Use cases

1. **Persistent AI memory** — "Remember that my preferred stack is Next.js + Supabase. Next time I ask about a project, pull this context automatically."

2. **Cross-session continuity** — "What were the open items from my last planning session?" — the AI recalls from the graph without needing the original conversation.

3. **Decision logging** — "Note that we decided to use RSA-4096 instead of ECDSA for the signing key, because of the HSM vendor's limitation." Retrieved months later in any AI client.

4. **Project context** — Save architecture decisions, stakeholder preferences, and constraints once; every AI session starts with full context.

5. **Knowledge base Q&A** — Ingest documents, articles, and meeting notes; ask questions against them semantically from any client.

6. **SOP execution** — Store a step-by-step process (e.g. "release checklist") as a Skill; have the AI walk through it, capture outputs, and resume across sessions.

7. **Private journaling** — Store personal notes in a sensitive-tier engram; they require explicit in-app consent before any AI can read them.

---

## Tool list (47 tools)

### Core memory
| Tool | What it does |
|------|-------------|
| `recall` | Semantic search over the knowledge graph |
| `remind` | Alias for recall, framed around "remind me about…" intent |
| `dig_deeper` | Escalation search: source-filename expansion + cross-engram entity hop |
| `remember` | Save a note to the graph |
| `edit` | Correct or update an existing memory (produces a diff for user approval) |
| `apply` | Commit a user-approved correction diff |
| `forget` | Soft-delete specific memory nodes |
| `stats` | Inspect graph state: node counts, source counts per engram |

### Navigation
| Tool | What it does |
|------|-------------|
| `list_engrams` | List all knowledge collections (name, tier, source count) |
| `suggest_engram` | Recommend the best engram to route a new note into |
| `browse_engram` | List all sources inside one engram |
| `recent` | Most recently ingested sources across all engrams |
| `get_engram_schema` | Fetch engram metadata (tier, template) |

### Advanced recall
| Tool | What it does |
|------|-------------|
| `recall_structured` | Returns recall results as a JSON node array (for programmatic use / before `forget`) |
| `recall_with_citations` | Recall with inline per-fact source citations |
| `compare_engrams` | Same query against two engrams side-by-side |
| `cross_search` | Federated recall over a hand-picked subset of engrams |

### Source management
| Tool | What it does |
|------|-------------|
| `find_source` | Search sources by metadata keyword or content description |
| `recall_source` | Full content of one source in ingestion order |
| `transfer_source` | Move a source between engrams |
| `ingest_batch` | Save up to 20 notes in one call, each with its own target engram |

### Memory health
| Tool | What it does |
|------|-------------|
| `engram_summary` | Node count + content previews for one engram |
| `audit_memory` | Near-duplicate detection across engrams |
| `check_duplicate` | Pre-save duplicate check for a note |
| `duplicate_pairs` | Pre-computed high-confidence duplicate pairs from background scan |
| `healing_journal` | Log of autonomous corrections applied by the background engine |
| `vitality` | 0–100 graph health score |

### Local AI (require Ollama)
| Tool | What it does |
|------|-------------|
| `develop` | Strategic plan grounded in the user's memory |
| `predict` | Risk and opportunity assessment before an action |
| `insights` | Background-computed patterns, gaps, and opportunities |
| `llm_query` | Synthesised answer from recalled context, computed locally |
| `llm_distill` | Extract discrete facts from arbitrary text, ready for `ingest_batch` |
| `gnn_status` | Neural network status and edge count |
| `gnn_neighbors` | GNN-predicted related nodes for a query |

### Consent
| Tool | What it does |
|------|-------------|
| `confirm_data_access` | Validate a time-limited consent phrase for sensitive-tier access |

### Skills (SOPs)
| Tool | What it does |
|------|-------------|
| `train_skill` | Personalise a skill/SOP using the user's memories |
| `skill_vitality` | 0–100 freshness score for a trained skill |
| `export_skill` | Export a trained skill as CLAUDE.md, .cursorrules, system prompt, or .gsk pack |
| `list_skills` | List all trained skills with metadata |
| `walk_skill` | Walk a skill as narrative SOP text |
| `walk_skill_structured` | Walk a skill as a JSON execution plan (for AI-driven execution) |
| `save_skill_run` | Persist multi-step execution state for cross-session resume |
| `resume_skill_run` | Reload a saved skill run to continue from where it left off |
| `get_skill` | Retrieve a trained skill's full text and metadata |
| `skill_history` | Full version history of a skill |
| `rollback_skill` | Restore a skill to a prior snapshot |
| `delete_skill` | Soft-delete a trained skill |

---

## Reviewer test-setup script

### Prerequisites

1. Download and install **Graphnosis** from [graphnosis.com](https://graphnosis.com) (macOS, Windows, or Linux).
2. Launch the app and create a new cortex:
   - Choose a folder (e.g. `~/Documents/GraphnosisTest`)
   - Set a passphrase (e.g. `test-passphrase-123`)
   - Leave the default engram as `personal`
3. Note the cortex folder path — you'll enter it when installing this connector.

### Install the connector

1. In Claude Desktop: **Settings → Extensions → Install from file**
2. Select `graphnosis-1.13.5.mcpb`
3. Fill in the prompted fields:
   - **Cortex folder**: path from step 2 above (e.g. `/Users/you/Documents/GraphnosisTest`)
   - **Cortex passphrase**: `test-passphrase-123`
   - **Default engram**: leave blank (defaults to `personal`)

### Quick smoke test (< 2 minutes)

In Claude Desktop, start a new conversation and try:

```
Save a note: "My preferred stack for new projects is Next.js + Tailwind + Supabase."
```
→ Claude calls `remember`. Graphnosis shows a banner confirming the save.

```
What stack do I prefer for new projects?
```
→ Claude calls `recall`. Returns the note you just saved with a deterministic audit footer.

```
What engrams do I have?
```
→ Claude calls `list_engrams`. Returns at least the `personal` engram.

```
Show me my graph stats.
```
→ Claude calls `stats`. Returns node count and source count for `personal`.

### Expected behavior

- All 4 calls above succeed without error
- `recall` returns the saved note with an `_anchored on entities: …_` audit footer
- No network requests (verify with Activity Monitor / Resource Monitor — only local disk I/O)
- `GRAPHNOSIS_EMBED_DISABLE=1` is set automatically by this connector, so local embeddings are disabled; recall falls back to TF-IDF (still accurate for exact and near-exact matches)

### Cleanup

Delete the test cortex folder after review. All MCP tool calls exchanged data between Claude Desktop and the local Graphnosis sidecar. Recalled content traveled through Claude Desktop's normal inference path and is subject to Anthropic's privacy policy. Graphnosis has no servers — nothing was sent to or stored by Graphnosis.
