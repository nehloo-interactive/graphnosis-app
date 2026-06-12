---
title: Memory-trained Skills
description: How Graphnosis represents Memory-trained Skills as Standard Operating Procedures (SOPs) — the graph model, the eight goal categories, the snapshot history, the .gsk wire format, and the Free vs Pro training paths.
sidebar:
  order: 2
---

A **Skill** in Graphnosis is a Standard Operating Procedure (SOP) — a step-by-step instruction set, anchored to your cortex and made callable by any MCP client. They're called **Memory-trained Skills** because the training pass compiles the relevant memories from your engrams into the skill body: each one is grounded in what you actually know and decided, not a generic template. Skills live in their own **Skills engram** that ships with every cortex on first unlock.

This page is the reference for the procedural-memory model: the graph shape, the eight goal categories, how retraining writes snapshots into a side-table history, the `.gsk` wire format, and the two training paths (Free deterministic vs. Pro LLM-assisted). The companion AI-facing surface is in the [MCP Tools reference — Skills (SOPs)](/reference/mcp-tools/#skills-sops).

## The procedural model in one diagram

Each skill is a sequence of body steps stored in source order — the same order the user sees in the editor. Five evidence-tagged edge types wire the steps into an executable graph:

| Relationship | Edge type | Evidence | Weight |
|---|---|---|---|
| Step N → step N+1 (linear) | `precedes` | `skill:seq` | 0.9 |
| "Go back to step X" (loop) | `precedes` | `skill:loop` | 0.7 |
| Conditional fork to step Y | `depends-on` | `skill:branch` | 0.75 |
| Recalled memory anchored to step N | `supports` | `skill:ctx` | 0.6 |
| Step invokes another skill | `contains` | `skill:calls` | 0.95 |

`precedes` for loops reuses the existing edge type — the `evidence` tag is the discriminator. Cycles are intentional for loops; the walker uses the source `nodeIds` order (not edge traversal) for the linear chain, so back-edges never cause infinite loops. `contains` for sub-skill invocation reads naturally: "this step contains, or is realized by, this other skill."

The Skills engram itself is a normal engram — same encryption, same op-log, same recall caps — so the five SOP edges live in the same `.gai` graph as everything else. Nothing about Skills bypasses the deterministic substrate.

## Position-aware recall placement

The training pipeline doesn't dump recalled memories at the end of a skill as a flat block. It **places** each candidate fragment at the position in the procedure where it actually fits — between the steps it elaborates on. Placement uses a two-step deterministic check:

1. **Similarity** between the candidate and the surrounding step pair (`prev` + `next`).
2. **Triplet coherence** — does the candidate read sensibly between `prev` and `next`? Same-sentence Jaccard on the trailing sentence of `prev` and the leading sentence of `next`.

If the combined score falls below threshold, the fragment is appended to a `Supporting context` block at the end of the skill instead of being shoe-horned mid-procedure. The skill always reads as a coherent SOP at every point.

Anchored fragments carry an `_(from <source-name>)_` attribution marker. The marker is language-neutral — it is always injected in English regardless of the skill's body language, so downstream detection (recall enrichment, the `_anchored …_` audit footer, the `walk_skill` output) is uniform across cortexes in any language.

## The eight goal categories

Every skill body can declare up to eight goal categories. Each is a paragraph node tagged with a prefix; the editor renders them as colored chips and `linkSkillGoals` wires each one to the title with a `contains/skill:goal` edge.

| Category | Prefix | Purpose |
|---|---|---|
| ✓ Success | `Success:` | What success looks like — used by `walk_skill` as the top-line outcome. |
| ✗ Out of scope | `Out of scope:` | What this skill explicitly will not do — keeps the AI from over-reaching. |
| ⊙ On completion | `On completion:` | What artifacts/state should exist when the skill finishes. |
| ⚡ Trigger | `Trigger:` | The user intent that should fire this skill — pattern-matched on user messages. |
| 🔑 Prerequisites | `Prerequisites:` | What must be true before step 1 runs. Surfaced to the user before execution. |
| ⚠ On failure | `On failure:` | The recovery path. May contain an `@skill: rollback-X` reference; the parser emits a `skill:calls;onFailure=true` edge and `walk_skill_structured` surfaces it as a `failureHandlers[]` entry. |
| 🔌 Requires | `Requires:` | Named inputs this skill expects from its caller or context (`$camelCase` by convention). |
| 📤 Produces | `Produces:` | Named outputs this skill makes available to callers. |

The first three (Success, Out of scope, On completion) were the original three. The other five were added when the SOP model landed — they are what makes a skill executable rather than just readable.

## Cross-skill orchestration

A step inside one skill can invoke another skill. Two equivalent forms are supported; both compile to the same `skill:calls` edge.

**Bare form** — quick reference, no args, no return:

```
@skill: target-skill-name
```

**Full form** — args + return capture:

```
@skill: target-skill-name(branch=$branch, depth=fast) -> $envOk
```

Args may be literals (`depth=fast`) or variable references (`branch=$branch`). The captured variable (`$envOk`) is available to subsequent steps in the calling skill. The AI executor — reading the JSON from `walk_skill_structured` — is responsible for resolving variables, invoking the sub-skill, and storing the return.

Cross-skill calls are encoded in the edge's `evidence` string so the SDK doesn't need bespoke metadata fields:

```
evidence = 'skill:calls'                                 # bare reference
evidence = 'skill:calls;capture=envOk'                   # captures return
evidence = 'skill:calls;args=branch,depth;capture=envOk' # full form
evidence = 'skill:calls;onFailure=true'                  # call lives in an On failure: block
evidence = 'skill:calls;parallel=true'                   # member of an @parallel group
```

### Concurrent sub-skills — `@parallel`

A step can dispatch several sub-skills at once and capture each return positionally:

```
@parallel: [validate-env, smoke-tests(branch=$b)] -> [$envOk, $smoke]
```

Each member becomes its own `skill:calls` edge tagged `parallel=true`; `walk_skill_structured` surfaces them as a `parallel[]` array on the step, and `walk_skill` prints `→ INVOKES IN PARALLEL: A | B`. The executor runs the members concurrently and stores each return under its positional variable.

### Loop convergence caps — `@loop: N max=M`

A loop can carry a convergence guard — loop back to step *N*, **at most *M* times**:

```
@loop: 2 max=5
```

This encodes as `skill:loop;max=M` and surfaces as `maxIterations` per step (and `(max N iterations)` in the narrative walk), so an executor can stop a non-progressing loop instead of spinning. Uncapped loops behave exactly as before.

### Typed inputs in `Requires:`

`Requires:` accepts inline `:type` hints so an executor can validate values before invoking:

```
Requires: $branch:string, $policy:{phased|atomic}, $count:number
```

`walk_skill_structured` exposes these as `requiresTypes: {name: type}`. The legacy untyped, space-separated form still works.

### Cross-engram calls

A `@skill:` (or `@parallel:`) target can now live in **another Skills engram**. Because the SDK's edge model is strictly intra-graph, cross-engram resolutions are persisted in an encrypted side-table next to the cortex and merged into the walk — surfaced with a `targetGraphId` on the call. Same-engram targets are unchanged; you don't have to do anything to opt in.

## Training paths — Free vs Pro

`train_skill` has two paths. Which one runs is decided by the user's license and Local LLM availability — the AI client does not pick.

| Path | Requires | What it does |
|---|---|---|
| **Free — memory-augmented** | Nothing extra | Deterministic. Recall is run against the cortex for each body step; the top fragments are placed in-line with `_(from source)_` attribution, between the steps they fit. The body the user wrote is preserved verbatim. |
| **Pro — LLM-rewritten with attribution** | Pro license + Local LLM | Non-deterministic body, deterministic recall. The local LLM rewrites the body steps to integrate the recalled context fluently, but every fact pulled in keeps its `_(from source)_` marker so the lineage is preserved. The rewrite happens entirely on-device. |

Both paths produce a snapshot in the skill's history. Both update the five SOP edge types. The Pro path adds an `autonomous retrain` capability — the brain engine can re-run training on a schedule when the cortex has changed enough to warrant it.

## In-place retrain + snapshot history

Older versions of Graphnosis created a new source per training run. That bloated the Skills engram and made the recall surface noisy. The current model:

- **One source per skill.** Retraining mutates the existing source in place via the op-log; the `sourceId` is stable across retrains. Old recall results, MCP tool calls, and inbound `@skill:` references continue to resolve.
- **Snapshots in an encrypted side-table.** Every retrain writes a snapshot of the prior body, goals, and edges to a per-cortex side-table. Snapshots include the mode (`deterministic` vs `llm`), timestamp, and a diff summary against the previous one.
- **History is browsable** via the `skill_history` MCP tool or the Skills page UI.
- **Rollback is one click.** `rollback_skill` (or the UI button) restores any snapshot. The rollback itself is recorded as a new snapshot so the lineage is preserved — nothing is destroyed.

This is the same indelibility model the rest of Graphnosis uses for memory: corrections demote, they don't delete.

## What ships out of the box — Bundled Skill Demos

On the first unlock of a fresh cortex, Graphnosis auto-loads three signed `.gsk` demo packs into a dedicated **Skill Demos** engram:

- **Code review** — a single-skill demo showing `Prerequisites:`, `Trigger:`, and `On failure:` in use, without cross-skill calls.
- **Safe Deploy** — a six-skill cross-skill orchestration example: a top-level `Production deployment` skill that calls `validate-environment`, `run-migrations`, `smoke-tests` with explicit `$captures`, and routes failures to `rollback-deployment` and `rollback-migrations`.
- **Comprehensive job memory** — a longer SOP demonstrating position-aware placement and the full eight-goal block on a single procedure.

The demos are signed with the Graphnosis publisher key and verified on load. You can inspect, edit, retrain, or delete them — they are normal skills in a normal engram. If you delete the engram, the demos do not return on the next unlock; the loader checks for a one-time marker.

## The `.gsk` wire format

Skills are exported and shared as `.gsk` packs (Graphnosis Skill Kit). Format reference: [File formats — `.gsk`](/reference/file-formats/#gsk--graphnosis-skill-kit). One-line summary: AES-256-GCM encrypted JSON body, Ed25519 signature over the manifest + payload, magic bytes `GSK\x01`.

The macOS and Windows desktop apps both register `.gsk` as a known file type — double-clicking one prompts the Graphnosis app to import it into the cortex you choose.

`.gsk` replaces the earlier `.gts` extension. Files written before the rename still import — the loader matches on magic bytes, not the filename.

## What an AI sees

The MCP surface for Skills is twelve tools. The two most important are:

- **`walk_skill`** — narrative SOP text for human-facing guidance (chat with the user about the procedure).
- **`walk_skill_structured`** — JSON `SkillExecutionPlan` for the AI to actually execute the skill — `requires`, `produces`, ordered `steps` with `calls` metadata, and `failureHandlers`.

The remaining ten cover the lifecycle and multi-session runs: `get_skill`, `list_skills`, `train_skill`, `export_skill`, `delete_skill`, `skill_history`, `rollback_skill`, `skill_vitality`, plus `save_skill_run` / `resume_skill_run` (persist a multi-skill run's captured variables and progress, then resume it in a later session). See [MCP Tools — Skills (SOPs)](/reference/mcp-tools/#skills-sops) for parameters and examples.

## Failure-mode taxonomy

Every failure surfaces in the structured output as an annotation. The AI executor decides what to do.

| Failure | Where it surfaces | AI executor action |
|---|---|---|
| Prerequisite unmet | `constraints.prerequisites` populated | Ask user / abort before step 1. |
| Step exceeds scope | `constraints.outOfScope` matches user request | Refuse and explain. |
| Sub-skill not found | `steps[i].calls.unresolvedCall: 'name'` | Surface to user; do not auto-create. |
| Sub-skill execution fails | Caller's `failureHandlers[]` is non-empty | Invoke handler, pass captured failure. |
| Loop won't converge | `steps[i].maxIterations` (from `@loop: N max=M`) | Stop after the declared cap; uncapped loops still need the executor's own guard. |
| Branch condition ambiguous | `steps[i].branchesTo` has multiple targets | Ask user which branch. |

---

## Related

[MCP Tools — Skills (SOPs)](/reference/mcp-tools/#skills-sops) — parameters and examples for all twelve Skills tools.

[File Formats — `.gsk`](/reference/file-formats/#gsk--graphnosis-skill-kit) — the signed wire format for exported skills.

[Federated Multi-Graphs](/reference/federated-multi-graphs/) — the dual-graph the Skills engram lives on.

[A GRAPHNOSIS.md for Your AI](/getting-started/graphnosis-md/) — drop-in instructions that tell AI clients to use `walk_skill_structured`.

[The Story of Ghampus](/reference/ghampus/) — who actually trains the skill.

