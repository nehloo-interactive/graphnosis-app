#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { embeddings, policy } from '@graphnosis-app/core';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { startIpc } from './ipc.js';
import { startMcpServer } from './mcp-server.js';
import { LLM_CATALOG, makeLlm } from './local-llm.js';
import { localEmbed, LOCAL_EMBED_ID, LOCAL_EMBED_DIM } from './local-embed.js';
import type { LocalLlm } from './correction.js';
import type { CorrectionDiff } from './correction.js';

interface CliEnv {
  vaultDir: string;
  passphrase: string;
  deviceId: string;
  defaultGraph: string;
  llmId?: string;
}

function loadEnv(): CliEnv {
  const required = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var: ${k}`);
    return v;
  };
  return {
    vaultDir: required('GRAPHNOSIS_VAULT'),
    passphrase: required('GRAPHNOSIS_PASSPHRASE'),
    deviceId: process.env.GRAPHNOSIS_DEVICE_ID ?? `${os.hostname()}-${process.pid}`,
    defaultGraph: process.env.GRAPHNOSIS_DEFAULT_GRAPH ?? 'personal',
    ...(process.env.GRAPHNOSIS_LLM ? { llmId: process.env.GRAPHNOSIS_LLM } : {}),
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const adapter = new GraphnosisImpl();

  // Policy can be supplied via $GRAPHNOSIS_POLICY (path to JSON) for tiered graphs.
  // Shape: { graphs: [{ graphId, tier?: 'public'|'personal'|'sensitive', shareWithAi? }] }
  // Until the desktop UI manages this, env-driven is the override path.
  // Missing file is warned, not fatal — easier to bootstrap.
  let policyCfg: policy.PolicyConfig | undefined;
  if (process.env.GRAPHNOSIS_POLICY) {
    try {
      const { promises: fs } = await import('node:fs');
      const raw = await fs.readFile(process.env.GRAPHNOSIS_POLICY, 'utf8');
      const parsed = JSON.parse(raw) as { graphs?: policy.GraphPolicy[] };
      policyCfg = { defaultBudget: policy.DEFAULT_BUDGET, graphs: parsed.graphs ?? [] };
      console.error(`[graphnosis-sidecar] policy loaded from ${process.env.GRAPHNOSIS_POLICY} (${policyCfg.graphs.length} graphs)`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        console.error(`[graphnosis-sidecar] WARNING: GRAPHNOSIS_POLICY=${process.env.GRAPHNOSIS_POLICY} not found — running with defaults. Create the file to apply per-graph tiers.`);
      } else {
        console.error(`[graphnosis-sidecar] WARNING: failed to read policy file: ${err.message} — running with defaults.`);
      }
    }
  }

  // Local embedding model — real semantic search via fastembed (ONNX, BGE-small-en-v1.5).
  // First call downloads the model (~33MB) to the cache dir; subsequent calls are offline.
  // If init fails (e.g., onnxruntime native binary missing on this platform), we degrade
  // to the SHA-derived stub so the server still boots — TF-IDF still works.
  let embedFn = embeddings.stubEmbed;
  let embedAdapterId = 'graphnosis-app:stub@384';
  let embedDimensions = 384;
  if (process.env.GRAPHNOSIS_EMBED_DISABLE !== '1') {
    try {
      // Probe with a tiny embed so any model-download / native-binary issue surfaces at boot.
      const probe = await localEmbed('graphnosis boot probe');
      if (probe.length !== LOCAL_EMBED_DIM) throw new Error(`unexpected embedding dim ${probe.length}`);
      embedFn = localEmbed;
      embedAdapterId = LOCAL_EMBED_ID;
      embedDimensions = LOCAL_EMBED_DIM;
      console.error(`[graphnosis-sidecar] local embeddings ready (${LOCAL_EMBED_ID})`);
    } catch (e) {
      console.error(`[graphnosis-sidecar] WARNING: local embeddings unavailable (${(e as Error).message}) — falling back to TF-IDF-only retrieval. Set GRAPHNOSIS_EMBED_DISABLE=1 to silence.`);
    }
  }

  const host = await GraphnosisHost.open({
    vaultDir: env.vaultDir,
    passphrase: env.passphrase,
    deviceId: env.deviceId,
    adapter,
    embed: embedFn,
    embedAdapterId,
    embedDimensions,
    ...(policyCfg ? { policy: policyCfg } : {}),
  });

  // Ensure default graph exists/loads.
  try {
    await host.loadGraph(env.defaultGraph);
  } catch {
    await host.createGraph(env.defaultGraph);
  }

  let llm: LocalLlm | null = null;
  const choice = LLM_CATALOG.find(c => c.id === env.llmId) ?? LLM_CATALOG.find(c => c.recommended);
  if (choice) {
    try {
      llm = makeLlm(choice);
    } catch (e) {
      console.error(`[graphnosis-sidecar] Local LLM (${choice.id}) unavailable: ${(e as Error).message}`);
    }
  }

  const pendingDiffs = new Map<string, { graphId: string; diff: CorrectionDiff }>();

  // IPC for the Tauri shell.
  const socketPath = process.env.GRAPHNOSIS_IPC_SOCKET
    ?? path.join(env.vaultDir, 'sidecar.sock');
  await startIpc({ host, socketPath });
  console.error(`[graphnosis-sidecar] IPC listening on ${socketPath}`);

  // MCP server over stdio for Claude Desktop / Claude Code / Cursor.
  // Logs go to stderr only; stdout is the MCP transport.
  await startMcpServer({
    host,
    llm: () => llm,
    defaultGraphId: () => env.defaultGraph,
    pendingDiffs,
  });
}

main().catch((e) => {
  console.error('[graphnosis-sidecar] fatal:', e);
  process.exit(1);
});
