// @disclosure: (a) publishable — Spec only — asserts the restore-point contract:
//   what a snapshot must contain, that promoting is itself undoable, that retention
//   is bounded, and that a loaded engram is refused. No defect mechanism, no
//   reproduction of a shipped failure.
// @disclosure-src: added 2026-08-04 · class (a) by construction · enforced by scripts/check-disclosure-tags.sh
/**
 * Restore points (4.96-B).
 *
 * These exist because a destructive operation lost a real source from a real
 * cortex, and every recovery route available afterwards required knowing the
 * on-disk layout. A safety net nobody can reach is not a safety net — and an
 * UNTESTED one is worse than none, because it promises a guarantee it may not
 * keep. Hence this file.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { GraphnosisHost } from '../dist/host.js';
import { GraphnosisImpl } from '../dist/graphnosis-impl.js';

const dirs = [];
after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function openHost() {
  const cortexDir = path.join(os.tmpdir(), `gn-restore-points-${process.pid}-${dirs.length}`);
  dirs.push(cortexDir);
  await fs.rm(cortexDir, { recursive: true, force: true });
  const { host } = await GraphnosisHost.open({
    cortexDir,
    passphrase: 'restore-points-test',
    deviceId: 'this-device',
    adapter: new GraphnosisImpl(),
  });
  await host.createGraph('g');
  await host.ingest('g', 'text', 'seed.md', {
    kind: 'markdown',
    content: '# Seed\n\nA paragraph that exists so the engram has bytes on disk.\n',
    sourceRef: 'seed.md',
  }, { triggeredBy: 'test' });
  await host.save('g');
  return { host, cortexDir };
}

test('a restore point captures the graph and its bundle together', async () => {
  const { host, cortexDir } = await openHost();
  const label = await host.writeRestorePoint('g', 're-ingest seed.md');
  assert.ok(label, 'no restore point was written');

  const graphs = path.join(cortexDir, 'graphs');
  assert.ok(existsSync(path.join(graphs, `g.gai${label}`)), 'graph copy missing');
  // Together or not at all: the bundle shrinks when content is released, so a
  // graph restored beside a newer bundle references content the bundle lacks.
  assert.ok(existsSync(path.join(graphs, `g.bundle${label}`)), 'bundle copy missing');

  const [point] = await host.listRestorePoints('g');
  assert.equal(point.label, label);
  assert.equal(point.operation, 're-ingest seed.md', 'the operation must be recoverable, not just the time');
  assert.equal(point.hasBundle, true);
  assert.ok(point.sizeBytes > 0, 'a zero-byte point would restore nothing');
});

test('a point survives losing its metadata, and says the operation is unknown', async () => {
  // The graph bytes are what matter. Hiding a point because its label file went
  // missing would strand a perfectly usable copy.
  const { host, cortexDir } = await openHost();
  const label = await host.writeRestorePoint('g', 'some operation');
  await fs.rm(path.join(cortexDir, 'graphs', `g.gai${label}.meta`), { force: true });

  const [point] = await host.listRestorePoints('g');
  assert.equal(point.label, label, 'point vanished when its metadata did');
  assert.equal(point.operation, 'unknown operation');
});

test('promoting restores the bytes AND is itself undoable', async () => {
  const { host, cortexDir } = await openHost();
  const graphFile = path.join(cortexDir, 'graphs', 'g.gai');
  const before = await fs.readFile(graphFile);

  const label = await host.writeRestorePoint('g', 'about to change things');

  // Diverge on disk, with the engram closed so nothing rewrites it underneath.
  await host.unloadGraph('g');
  await fs.writeFile(graphFile, Buffer.concat([before, Buffer.from('DIVERGED')]));
  assert.notEqual((await fs.readFile(graphFile)).length, before.length);

  const { replacedBy } = await host.promoteRestorePoint('g', label);
  assert.deepEqual(await fs.readFile(graphFile), before, 'promote did not restore the original bytes');
  assert.ok(replacedBy, 'promote must snapshot what it replaces — otherwise restoring is a one-way door');
  assert.notEqual(replacedBy, label);

  // The state promote overwrote is itself recoverable.
  const labels = (await host.listRestorePoints('g')).map((p) => p.label);
  assert.ok(labels.includes(replacedBy), 'the replaced state was not kept');
});

test('a loaded engram is refused rather than silently overwritten', async () => {
  // Writing the file under a resident graph leaves memory and disk disagreeing
  // until the next save quietly rewrites the file back.
  const { host } = await openHost();
  const label = await host.writeRestorePoint('g', 'while open');
  await assert.rejects(
    () => host.promoteRestorePoint('g', label),
    /currently open/,
    'promoting under a loaded engram must be refused',
  );
});

test('retention is bounded, and the newest survive', async () => {
  const { host } = await openHost();
  const written = [];
  for (let i = 0; i < 8; i++) {
    // Distinct ISO stamps; the label is second-resolution.
    await new Promise((r) => setTimeout(r, 1100));
    written.push(await host.writeRestorePoint('g', `operation ${i}`));
  }
  const points = await host.listRestorePoints('g');
  assert.ok(points.length <= 5, `retention unbounded: ${points.length} points kept`);
  // Newest first, and the newest is the one just written.
  assert.equal(points[0].label, written[written.length - 1], 'newest point is not first');
  assert.equal(points[0].operation, 'operation 7');
});

test('a bogus label is rejected rather than treated as a path', async () => {
  const { host } = await openHost();
  await assert.rejects(() => host.promoteRestorePoint('g', '../../etc/passwd'), /not a restore point/);
  await assert.rejects(() => host.promoteRestorePoint('g', '.restore-nope'), /no longer exists/);
});

test('an engram with no points lists none rather than failing', async () => {
  // POSITIVE CONTROL for the listing path: proves an empty result means "none",
  // not "the scan silently threw".
  const { host } = await openHost();
  assert.deepEqual(await host.listRestorePoints('g'), []);
  const label = await host.writeRestorePoint('g', 'now there is one');
  assert.equal((await host.listRestorePoints('g')).length, 1, 'listing found nothing after a write');
  assert.ok(label);
});
