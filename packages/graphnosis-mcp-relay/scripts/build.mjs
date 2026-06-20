import { mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sidecarDist = join(root, '../../apps/desktop-sidecar/dist/mcp-relay.js');
const outDir = join(root, 'dist');
const out = join(outDir, 'mcp-relay.js');

if (!existsSync(sidecarDist)) {
  console.error(
    'Missing compiled relay at apps/desktop-sidecar/dist/mcp-relay.js\n' +
      'Run: pnpm --filter @graphnosis-app/desktop-sidecar build',
  );
  process.exit(1);
}

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
