---
title: Performance and recall latency
description: How Graphnosis measures recall speed, what the marketing numbers mean, and when to run manual benchmarks.
sidebar:
  order: 12
---

Graphnosis recall is **local and deterministic** — no cloud round-trip — but latency still depends on cortex size, hardware, cache warmth, and whether you search one engram or many.

## What the ~75 ms figure means

Marketing and the home-page stats strip cite **~75 ms median recall** measured on a **single engram** with a **warm embedding cache**, using the **local hybrid** retrieval path (BGE-small embeddings + graph expansion) on **developer hardware**. The reference corpus is about **12k nodes / 68k edges** — see the [SDK benchmarks methodology](https://github.com/nehloo/Graphnosis/blob/main/benchmarks/benchmarks.md) on GitHub.

That number is **not** a guarantee for:

- **Cold boot** — first recall after unlock while embeddings are still loading
- **Federated multi-engram** recall across many `.gai` files
- **Low-power or embedded** hardware without tuning (`GRAPHNOSIS_EMBED_WORKERS`, etc.)
- **Very large cortexes** (tens of thousands of nodes per engram) without a fresh baseline

Use it as a representative **warm, single-engram** datapoint — not a SLA.

## CI regression guard (every smoke test)

The desktop-sidecar smoke test ends with a `recall-latency-regression` phase:

1. Ingests the bundled docs offline into a `smoke-latency-bench` engram (deterministic corpus).
2. Runs one **warm-up** recall (not timed).
3. Times **5** recalls (override with `GRAPHNOSIS_RECALL_LATENCY_RUNS`) and computes **P50**.
4. **Fails** if P50 exceeds **200 ms** (override with `GRAPHNOSIS_RECALL_LATENCY_P50_MS`).

The 200 ms bar is an **internal regression guard** for CI — intentionally generous so flaky runners do not fail PRs. It is separate from the ~75 ms marketing benchmark.

Skip the phase locally when iterating: `GRAPHNOSIS_SKIP_RECALL_LATENCY=1`.

```sh
pnpm --filter @graphnosis-app/desktop-sidecar smoke
```

Look for JSON lines `recall-latency-regression.result` and `recall-latency-regression.ok` in the output.

## Manual large-cortex benchmark (pre-release)

Before tagging a release — especially after recall, embedding, or graph-index changes — run the manual script against your real cortex:

```sh
pnpm --filter @graphnosis-app/desktop-sidecar build

GRAPHNOSIS_CORTEX="$HOME/Documents/MyCortex" \
GRAPHNOSIS_PASSPHRASE="your-passphrase" \
GRAPHNOSIS_RECALL_BENCH_GRAPH=personal \
node apps/desktop-sidecar/scripts/recall-benchmark-manual.mjs
```

### Checklist

1. **Unlock** the cortex in the app (or pass `GRAPHNOSIS_PASSPHRASE` / `GRAPHNOSIS_RECOVERY_PHRASE`).
2. **Wait** for background brain / embedding work to finish (status bar quiet, no ingest spinner).
3. **Run** the script — default **10** timed runs after warm-up; records P50/P95 to stdout.
4. **Compare** to your last saved baseline (spreadsheet or release notes). Investigate regressions **> ~20%** before shipping.
5. Optional: set `GRAPHNOSIS_RECALL_LATENCY_P50_MS` to fail the script on a hard ceiling.

Optional env vars are documented in [Environment Variables](/reference/environment-variables/#recall-latency-benchmark).

## Tuning for constrained hardware

See [Enterprise FAQ — resource requirements](/guides/enterprise-faq/#resource-requirements) for RAM/CPU guidance and `GRAPHNOSIS_EMBED_WORKERS` / `GRAPHNOSIS_EMBED_DISABLE` trade-offs.
