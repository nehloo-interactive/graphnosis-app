/**
 * Regression gate — ephemeral cortex + GRAPHNOSIS_EVAL_MODE sidecar + full deterministic eval.
 * Does not touch ~/Graphnosis-test. Run after sidecar build (same cadence as smoke).
 *
 *   pnpm --filter @graphnosis-app/desktop-sidecar build
 *   pnpm --filter @graphnosis-app/desktop-sidecar ghampus-eval:gate
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DIST_INDEX = path.join(__dirname, '../dist/index.js');
const LOOP = path.join(__dirname, 'ghampus-eval-loop.mjs');

const CORTEX = process.env.GRAPHNOSIS_CORTEX
  ?? path.join(os.tmpdir(), `gn-ghampus-eval-${process.pid}`);
const SOCKET = path.join(CORTEX, 'sidecar.sock');
const PASSPHRASE = process.env.GRAPHNOSIS_PASSPHRASE ?? 'smoke-test';
const SIDEcar_START_MS = Number(process.env.GRAPHNOSIS_EVAL_SIDECAR_START_MS ?? 60_000);

function waitForSocket(ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - start > ms) {
        reject(new Error(`sidecar socket not ready after ${ms}ms (${SOCKET})`));
        return;
      }
      const s = net.connect(SOCKET);
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

async function main() {
  await mkdir(CORTEX, { recursive: true });

  const sidecar = spawn(process.execPath, ['--enable-source-maps', DIST_INDEX], {
    env: {
      ...process.env,
      GRAPHNOSIS_CORTEX: CORTEX,
      GRAPHNOSIS_PASSPHRASE: PASSPHRASE,
      GRAPHNOSIS_EVAL_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let sidecarLog = '';
  sidecar.stdout?.on('data', (c) => { sidecarLog += c; });
  sidecar.stderr?.on('data', (c) => { sidecarLog += c; });

  const killSidecar = () => {
    if (!sidecar.killed) sidecar.kill('SIGTERM');
  };

  try {
    await waitForSocket(SIDEcar_START_MS);
    console.log(`[ghampus-eval:gate] sidecar up cortex=${CORTEX}`);

    const loop = spawn(process.execPath, [LOOP], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GRAPHNOSIS_CORTEX: CORTEX,
        GRAPHNOSIS_EVAL_MODE: '1',
        GRAPHNOSIS_EVAL_PROFILE: 'deterministic',
        GRAPHNOSIS_EVAL_REPEATS: '1',
        GRAPHNOSIS_EVAL_CASE_GAP_MS: process.env.GRAPHNOSIS_EVAL_CASE_GAP_MS ?? '8000',
      },
      stdio: 'inherit',
    });

    const code = await new Promise((res) => loop.on('close', res));
    if (code !== 0) {
      console.error('[ghampus-eval:gate] FAIL — see ghampus-eval-results.jsonl in temp cortex');
      process.exit(code ?? 1);
    }
    console.log('[ghampus-eval:gate] PASS — 18-case deterministic gate green');
  } catch (err) {
    console.error('[ghampus-eval:gate] error:', err instanceof Error ? err.message : err);
    if (sidecarLog) console.error(sidecarLog.slice(-4000));
    process.exit(1);
  } finally {
    killSidecar();
    await new Promise((r) => sidecar.on('close', r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
