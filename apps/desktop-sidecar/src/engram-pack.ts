/**
 * Engram Pack — export and import logic for the `.gez` (Graphnosis Engram Zero)
 * air-gapped sharing format.
 *
 * Export: reads all sources + full node text from a live engram and serializes
 *         them into an encrypted, optionally-signed `.gez` file.
 *
 * Import: decrypts + verifies a `.gez` file and re-ingests each source into a
 *         target engram. Last-write-wins on matching sourceId; new sources
 *         coexist. Returns a per-source outcome report.
 *
 * Neither export nor import requires a network connection. All crypto is local.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import sodium from 'libsodium-wrappers-sumo';
import type { GraphnosisHost } from './host.js';
import { ingestClip } from './ingest.js';
import {
  buildGezPackage,
  parseGezPackage,
  verifyGezSignature,
  type GezPayload,
  type GezSourceEntry,
  type GezImportResult,
} from './gez-format.js';

// ── GEZ signing key management ────────────────────────────────────────────────

/**
 * Load or create the cortex's `.gez` signing key pair.
 *
 * The key pair is stored in `<cortexDir>/gez-signing.json` as a JSON object
 * with `{ secretKeyB64, publicKeyB64 }`. On first call a fresh Ed25519 key
 * pair is generated and persisted. On subsequent calls the stored key is
 * returned unchanged (stable across restarts — the same public key is always
 * embedded in packs exported from this cortex).
 *
 * The secret key is stored in plaintext (not encrypted) because it protects
 * pack authenticity, not pack confidentiality — the AES-256-GCM layer handles
 * confidentiality. Storing plaintext avoids threading the data key here.
 *
 * Returns the 64-byte secret key as a hex string (same format as signingKeyHex
 * accepted by buildGezPackage).
 */
export async function getOrCreateGezSigningKeyHex(cortexDir: string): Promise<string> {
  await sodium.ready;
  const keyFile = path.join(cortexDir, 'gez-signing.json');

  try {
    const raw = await fs.readFile(keyFile, 'utf8');
    const stored = JSON.parse(raw) as { secretKeyB64: string };
    const sk = Buffer.from(stored.secretKeyB64, 'base64');
    if (sk.length === 64) return sk.toString('hex');
  } catch {
    // File doesn't exist or is malformed — generate a new key pair below.
  }

  const kp = sodium.crypto_sign_keypair();
  const stored = {
    secretKeyB64: Buffer.from(kp.privateKey).toString('base64'),
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
  };
  await fs.writeFile(keyFile, JSON.stringify(stored), 'utf8');
  return Buffer.from(kp.privateKey).toString('hex');
}

// ── exportEngram ──────────────────────────────────────────────────────────────

export interface ExportEngramOptions {
  /**
   * 64-byte Ed25519 secret key (hex) used to sign the pack.
   * Obtain via `getOrCreateGezSigningKeyHex(cortexDir)`.
   * Omit for an unsigned pack (signature = "").
   */
  signingKeyHex?: string;
  /**
   * Human-readable identifier for the exporting device (shown in pack metadata).
   * Defaults to "unknown".
   */
  exportedBy?: string;
}

export interface ExportEngramResult {
  /** The `.gez` file bytes, ready to write to disk. */
  pack: Buffer;
  /** Number of sources included. */
  sourceCount: number;
  /** Whether the pack was signed. */
  signed: boolean;
}

/**
 * Export an engram to a `.gez` pack buffer.
 *
 * Reads all sources + full node text from the live host and encrypts them.
 * Optionally signs with the cortex's GEZ signing key.
 */
export async function exportEngram(
  host: GraphnosisHost,
  engramId: string,
  opts: ExportEngramOptions = {},
): Promise<ExportEngramResult> {
  const { signingKeyHex, exportedBy = 'unknown' } = opts;

  if (!host.listGraphs().includes(engramId)) {
    throw new Error(`Engram "${engramId}" is not loaded. Ensure the cortex is unlocked.`);
  }

  const meta = host.getGraphMetadata(engramId) ?? {};
  const displayName: string = (meta as any).displayName ?? engramId;
  const template: string = (meta as any).template ?? 'personal';
  const tier: string = (meta as any).sensitivityTier ?? 'personal';

  const sourceRecords = host.listSources(engramId);
  const nodes = host.listNodes(engramId);

  // Build a nodeId → sourceId lookup for full-text assembly
  const nodeToSource = new Map<string, string>();
  for (const n of nodes) {
    const srcId = host.getNodeSource(engramId, n.id);
    if (srcId) nodeToSource.set(n.id, srcId);
  }

  // Group node IDs by sourceId for text reconstruction
  const sourceNodes = new Map<string, string[]>();
  for (const src of sourceRecords) {
    sourceNodes.set(src.sourceId, []);
  }
  for (const n of nodes) {
    const srcId = nodeToSource.get(n.id);
    if (srcId && sourceNodes.has(srcId)) {
      sourceNodes.get(srcId)!.push(n.id);
    }
  }

  // Assemble sources with full text content
  const sources: GezSourceEntry[] = [];
  for (const src of sourceRecords) {
    // Skip soft-deleted sources (no node IDs remaining)
    const nodeIds = sourceNodes.get(src.sourceId) ?? [];
    if (nodeIds.length === 0) continue;

    // Reconstruct full text from nodes (same pattern as skill-trainer.ts export)
    const chunks: string[] = [];
    for (const nid of nodeIds) {
      const content = host.getFullNodeContent(engramId, nid);
      if (content) chunks.push(content);
    }
    const text = chunks.join('\n\n');
    if (!text.trim()) continue;

    const entry: GezSourceEntry = {
      sourceId: src.sourceId,
      kind: src.kind,
      ref: src.ref,
      text,
      ingestedAt: src.ingestedAt,
    };
    if (src.addedBy !== undefined) entry.addedBy = src.addedBy;
    sources.push(entry);
  }

  const payload: GezPayload = {
    formatVersion: '1',
    exportedBy,
    exportedAt: Date.now(),
    engramId,
    engramDisplayName: displayName,
    engramTier: tier as 'public' | 'personal' | 'sensitive',
    engramTemplate: template,
    sources,
    signerPublicKey: '',
    signature: '',
  };

  const pack = buildGezPackage(payload, signingKeyHex);
  return { pack, sourceCount: sources.length, signed: !!signingKeyHex };
}

// ── importEngram ──────────────────────────────────────────────────────────────

export interface ImportEngramOptions {
  /**
   * Target engram ID to ingest sources into.
   * If the engram doesn't exist, it will be created with the pack's metadata.
   * Defaults to the pack's original engramId.
   */
  targetEngramId?: string;
  /**
   * If true, skip sources whose sourceId already exists in the target engram.
   * If false, re-ingest them (content updates to matching sourceId).
   * Default: true.
   */
  skipExisting?: boolean;
  /**
   * Embed function wrapper used for ingestion. If not provided, uses the
   * host's default embed path.
   */
  withEmbedding?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Import a `.gez` pack buffer into the local cortex.
 *
 * For each source in the pack:
 *   - If `skipExisting=true` (default) and the sourceId already exists → skip
 *   - Otherwise: ingest via `ingestClip` with kind preserved
 *
 * Returns a full per-source outcome report.
 */
export async function importEngram(
  host: GraphnosisHost,
  packData: Buffer,
  opts: ImportEngramOptions = {},
): Promise<{ result: GezImportResult; payload: GezPayload }> {
  const payload = parseGezPackage(packData);
  const { skipExisting = true, withEmbedding } = opts;

  // Verify signature (non-fatal — we report it in the result)
  let signatureVerified = false;
  let unsigned = false;
  try {
    const sig = await verifyGezSignature(payload);
    signatureVerified = sig.verified;
    unsigned = sig.unsigned === true;
  } catch {
    // signature present but invalid — will surface in UI as warning
    signatureVerified = false;
  }

  const targetId = opts.targetEngramId ?? payload.engramId;

  // Create the engram if it doesn't exist
  if (!host.listGraphs().includes(targetId)) {
    await host.createGraph(targetId);
    await host.setGraphMetadata(targetId, {
      template: payload.engramTemplate as any,
      displayName: payload.engramDisplayName,
      createdAt: Date.now(),
    });
  }

  // Build set of existing sourceIds for skip logic
  const existing = new Set(
    skipExisting ? host.listSources(targetId).map((s) => s.sourceId) : [],
  );

  // Ingest sources
  const outcomes: GezImportResult['outcomes'] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const src of payload.sources) {
    if (skipExisting && existing.has(src.sourceId)) {
      outcomes.push({ sourceId: src.sourceId, ref: src.ref, status: 'skipped' });
      skipped++;
      continue;
    }

    try {
      const doIngest = () =>
        ingestClip(host, targetId, src.text, src.ref, {
          sourceKind: (src.kind === 'file' || src.kind === 'url') ? 'clip' : src.kind,
          addedBy: src.addedBy ? `gez-import:${src.addedBy}` : 'gez-import',
          triggeredBy: 'user:ingest',
        });

      const rec = withEmbedding ? await withEmbedding(doIngest) : await doIngest();
      outcomes.push({
        sourceId: src.sourceId,
        ref: src.ref,
        status: 'imported',
        newSourceId: rec.sourceId,
      });
      imported++;
    } catch (e) {
      outcomes.push({
        sourceId: src.sourceId,
        ref: src.ref,
        status: 'failed',
        error: (e as Error).message,
      });
      failed++;
    }
  }

  return {
    result: { imported, skipped, failed, outcomes, signatureVerified, unsigned },
    payload,
  };
}
