/**
 * Shared IPC helpers for Ghampus eval scripts.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function resolveEvalCortex() {
  return process.env.GRAPHNOSIS_CORTEX ?? path.join(os.homedir(), 'Graphnosis-test');
}

export function resolveEvalSocket(cortexDir = resolveEvalCortex()) {
  return process.env.GRAPHNOSIS_IPC_SOCKET ?? path.join(cortexDir, 'sidecar.sock');
}

let ipcNextId = 1;

export function ipcCall(socketPath, method, params, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const id = ipcNextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    const socket = net.connect(socketPath);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) {
          socket.destroy();
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
    socket.on('error', reject);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`IPC timeout for ${method}`));
    });
  });
}

export async function pollGhampusResponse(socketPath, baselineCount, timeoutMs = Number(process.env.GRAPHNOSIS_EVAL_POLL_MS ?? 180_000), sentAfterMs = 0) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hist = await ipcCall(socketPath, 'ghampus:history', {});
    const messages = hist?.messages ?? [];
    const ghampusMsgs = messages.filter((m) => m?.kind === 'ghampus');
    if (sentAfterMs > 0) {
      const newer = ghampusMsgs.filter((m) => Number(m?.ts ?? 0) > sentAfterMs);
      if (newer.length > 0) {
        const last = newer[newer.length - 1];
        return String(last?.text ?? '');
      }
    } else if (ghampusMsgs.length > baselineCount) {
      const last = ghampusMsgs[ghampusMsgs.length - 1];
      return String(last?.text ?? '');
    }
    await sleep(500);
  }
  throw new Error('Ghampus response timeout');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function appendJsonl(filePath, row) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(filePath, JSON.stringify(row) + '\n');
}
