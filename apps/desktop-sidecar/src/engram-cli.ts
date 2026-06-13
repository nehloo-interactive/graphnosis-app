#!/usr/bin/env node
/**
 * Standalone Engram Pack CLI — export and import `.gez` packs without the app.
 *
 * Useful for air-gapped / headless environments where the Tauri desktop app
 * is not available. Requires the cortex to be accessible (not locked by another
 * sidecar instance).
 *
 * Usage:
 *   GRAPHNOSIS_CORTEX=/path/to/cortex GRAPHNOSIS_PASSPHRASE='...' \
 *     node dist/engram-cli.js export --engram <id> [--out <file.gez>] [--no-sign]
 *
 *   GRAPHNOSIS_CORTEX=/path/to/cortex GRAPHNOSIS_PASSPHRASE='...' \
 *     node dist/engram-cli.js import <file.gez> [--target <engram-id>] [--overwrite]
 *
 * IMPORTANT: nothing else can hold the cortex lock while this runs.
 * Quit the app and any running sidecar first.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { embeddings } from '@graphnosis-app/core';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { workerEmbed, LOCAL_EMBED_ID, LOCAL_EMBED_DIM } from './local-embed.js';
import { exportEngram, importEngram, getOrCreateGezSigningKeyHex } from './engram-pack.js';

async function bootHost(cortexDir: string, passphrase: string): Promise<GraphnosisHost> {
  const adapter = new GraphnosisImpl();

  let embedFn = embeddings.stubEmbed;
  let embedAdapterId = 'graphnosis-app:stub@384';
  let embedDimensions = 384;
  try {
    const probe = await workerEmbed('graphnosis engram-cli probe');
    if (probe.length === LOCAL_EMBED_DIM) {
      embedFn = workerEmbed;
      embedAdapterId = LOCAL_EMBED_ID;
      embedDimensions = LOCAL_EMBED_DIM;
    }
  } catch (e) {
    console.error(`[engram-cli] embeddings unavailable: ${(e as Error).message} — falling back to stub.`);
  }

  const { host } = await GraphnosisHost.open({
    cortexDir,
    passphrase,
    deviceId: `engram-cli-${process.pid}`,
    adapter,
    embed: embedFn,
    embedAdapterId,
    embedDimensions,
  });
  return host;
}

async function main(): Promise<void> {
  const cortexDir = process.env.GRAPHNOSIS_CORTEX;
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE;

  if (!cortexDir || !passphrase) {
    console.error(
      'Usage:\n' +
      '  GRAPHNOSIS_CORTEX=/path GRAPHNOSIS_PASSPHRASE=... node dist/engram-cli.js export --engram <id> [--out <file.gez>] [--no-sign]\n' +
      '  GRAPHNOSIS_CORTEX=/path GRAPHNOSIS_PASSPHRASE=... node dist/engram-cli.js import <file.gez> [--target <id>] [--overwrite]',
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === 'export') {
    const engramIdx = args.indexOf('--engram');
    const outIdx = args.indexOf('--out');
    const noSign = args.includes('--no-sign');

    const engramId = engramIdx >= 0 ? args[engramIdx + 1] : undefined;
    if (!engramId) {
      console.error('Missing --engram <id>. Use graphs.list via the sidecar IPC to find engram IDs.');
      process.exit(1);
    }

    console.error(`[engram-cli] Opening cortex at ${cortexDir}…`);
    const host = await bootHost(cortexDir, passphrase);
    console.error(`[engram-cli] Loading engram ${engramId}…`);
    await host.ensureLoaded(engramId);

    let signingKeyHex: string | undefined;
    if (!noSign) {
      try {
        signingKeyHex = await getOrCreateGezSigningKeyHex(cortexDir);
      } catch (e) {
        console.error(`[engram-cli] Signing key unavailable: ${(e as Error).message} — exporting unsigned.`);
      }
    }

    const meta = host.getGraphMetadata(engramId) ?? {};
    const exportOpts: import('./engram-pack.js').ExportEngramOptions = {
      exportedBy: (meta as any).displayName ?? engramId,
    };
    if (signingKeyHex !== undefined) exportOpts.signingKeyHex = signingKeyHex;

    console.error(`[engram-cli] Exporting…`);
    const result = await exportEngram(host, engramId, exportOpts);

    const slug = ((meta as any).displayName ?? engramId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const outPath = (outIdx >= 0 ? args[outIdx + 1] : undefined) ?? path.join(process.cwd(), `${slug || engramId}.gez`);

    await fs.writeFile(outPath, result.pack);
    console.error(
      `[engram-cli] Exported ${result.sourceCount} source(s) → ${outPath}` +
      (result.signed ? ' (signed)' : ' (unsigned)'),
    );
    console.log(outPath); // stdout: the output path for scripting

  } else if (subcommand === 'import') {
    const packPath = args[1];
    if (!packPath) {
      console.error('Missing <file.gez>. Usage: node dist/engram-cli.js import <file.gez> [--target <id>] [--overwrite]');
      process.exit(1);
    }

    const targetIdx = args.indexOf('--target');
    const targetEngramId = targetIdx >= 0 ? args[targetIdx + 1] : undefined;
    const skipExisting = !args.includes('--overwrite');

    console.error(`[engram-cli] Opening cortex at ${cortexDir}…`);
    const host = await bootHost(cortexDir, passphrase);

    const packData = await fs.readFile(packPath);
    console.error(`[engram-cli] Importing ${packPath}…`);

    const importOpts: import('./engram-pack.js').ImportEngramOptions = { skipExisting };
    if (targetEngramId !== undefined) importOpts.targetEngramId = targetEngramId;

    const { result, payload } = await importEngram(host, packData, importOpts);

    const sigLine = result.unsigned
      ? 'unsigned'
      : result.signatureVerified ? 'signature verified ✓' : 'signature INVALID ⚠';

    console.error(
      `[engram-cli] Import complete.\n` +
      `  Source:    ${payload.engramDisplayName} (${payload.engramId})\n` +
      `  Exported:  ${new Date(payload.exportedAt).toISOString()} by ${payload.exportedBy}\n` +
      `  Signature: ${sigLine}\n` +
      `  Imported:  ${result.imported}\n` +
      `  Skipped:   ${result.skipped}\n` +
      `  Failed:    ${result.failed}`,
    );

    if (result.failed > 0) {
      console.error('\nFailed sources:');
      for (const o of result.outcomes.filter((o) => o.status === 'failed')) {
        console.error(`  - ${o.ref}: ${o.error}`);
      }
    }

    // Print JSON summary to stdout for scripting
    console.log(JSON.stringify({ imported: result.imported, skipped: result.skipped, failed: result.failed }));
    process.exit(result.failed > 0 ? 1 : 0);

  } else {
    console.error(`Unknown subcommand: ${subcommand ?? '(none)'}. Use 'export' or 'import'.`);
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`[engram-cli] Fatal: ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
