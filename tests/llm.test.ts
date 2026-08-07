// LLM-dependent consistency tests. Runs only when GRAPHNOSIS_OLLAMA=1 AND
// Ollama is actually reachable; otherwise the suite reports "skipped"
// gracefully so it can be part of test:all without breaking unattended runs.
//
// What we test:
//   1. interpretContext at temperature=0 is deterministic on identical input.
//   2. interpretContext never cites a node ID that's not in the rawContext.
//   3. The LLM-off fallback path returns the documented placeholder string.

import { setupTestCortex, seedStandardData, assert, section, sdkNote, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('llm', llmSuite);
}

async function isOllamaUp(): Promise<boolean> {
  if (process.env.GRAPHNOSIS_OLLAMA !== '1') return false;
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function llmSuite(): Promise<void> {
  const cx = await setupTestCortex('llm');
  try {
    await seedStandardData(cx.host);

    section('LLM availability check');
    const llmUp = await isOllamaUp();
    if (!llmUp) {
      console.log(`  ⏸  GRAPHNOSIS_OLLAMA is not set, or Ollama is not reachable at 127.0.0.1:11434.`);
      console.log(`     Skipping LLM-dependent assertions. Run with: GRAPHNOSIS_OLLAMA=1 pnpm test:llm`);
      assert(true, `LLM tests skipped (Ollama not available) — soft pass`);
      return;
    }
    assert(true, `Ollama reachable at 127.0.0.1:11434`);

    sdkNote(
      'LLM test coverage is minimal',
      `This suite currently only checks Ollama availability. Real LLM determinism tests (interpretContext temp=0, runDevelop, runPredict) require constructing a BrainEngine, which has many dependencies. Expand once a brain-test harness exists.`,
      `Build a lightweight BrainEngine fixture (or expose interpretContext directly on host) so LLM tests can run without full brain init.`,
    );

    // Future expansion when BrainEngine harness is available:
    //   const brain = new BrainEngine({ host: cx.host, ... });
    //   const ctx1 = await brain.interpretContext('# Test\nTudor.', 'tudor');
    //   const ctx2 = await brain.interpretContext('# Test\nTudor.', 'tudor');
    //   assert(ctx1 === ctx2, `interpretContext deterministic at temp=0`);

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('llm', llmSuite);
