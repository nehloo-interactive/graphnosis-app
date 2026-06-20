import { mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(root, '../..');
const sidecarDist = join(repoRoot, 'apps/desktop-sidecar/dist/mcp-relay.js');
const outDir = join(root, 'dist');
const out = join(outDir, 'mcp-relay.js');

function runPnpm(args) {
  const r = spawnSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function ensureSidecarRelayBuilt() {
  if (existsSync(sidecarDist)) return;
  console.log(
    'Sidecar relay not compiled — building core + sidecar for npm package copy…',
  );
  runPnpm(['--filter', '@graphnosis-app/core', 'run', 'build']);
  runPnpm(['--filter', '@graphnosis-app/desktop-sidecar', 'run', 'build']);
  if (!existsSync(sidecarDist)) {
    console.error(
      'Missing compiled relay at apps/desktop-sidecar/dist/mcp-relay.js after sidecar build.',
    );
    process.exit(1);
  }
}

ensureSidecarRelayBuilt();

mkdirSync(outDir, { recursive: true });
copyFileSync(sidecarDist, out);
chmodSync(out, 0o755);

const binDir = join(root, 'bin');
const binSh = join(binDir, 'graphnosis-mcp-relay');
mkdirSync(binDir, { recursive: true });
if (!existsSync(binSh)) {
  throw new Error('Missing bin/graphnosis-mcp-relay — keep the shell wrapper in git');
}
chmodSync(binSh, 0o755);

console.log('Built', out, '(from sidecar dist)');
