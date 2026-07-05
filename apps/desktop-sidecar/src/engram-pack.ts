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
  buildGezPackageV2,
  parseGezPackageAny,
  verifyGezSignature,
  type GezPayload,
  type GezSourceEntry,
  type GezImportResult,
} from './gez-format.js';
import {
  ed25519ToCurveKeypairB64,
  recipientPublicKeyB64FromEd25519,
  type EncryptForOption,
  type DecryptOptions,
} from './pack-crypto.js';

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

// ── Recipient (X25519) keypair — derived from the GEZ signing Ed25519 ──────────

/**
 * The cortex's X25519 RECIPIENT key pair, derived from its existing Ed25519
 * pack-signing key via `crypto_sign_ed25519_*_to_curve25519`. Because both keys
 * derive from the same Ed25519 secret, "verified signer" (the pack's
 * `signerPublicKey`) and "sealed-to recipient" (this X25519 public key) are bound
 * to one published identity — no new keystore. The exporter encrypts a pack to a
 * peer's recipient PUBLIC key; the peer decrypts with its own recipient SECRET key.
 */
export async function getOrCreateRecipientCurveKeypair(
  cortexDir: string,
): Promise<{ publicKeyB64: string; secretKeyB64: string }> {
  const edHex = await getOrCreateGezSigningKeyHex(cortexDir);
  return ed25519ToCurveKeypairB64(edHex);
}

/** Just this cortex's X25519 recipient PUBLIC key (base64), for handing to peers
 *  who want to encrypt a pack to this cortex. */
export async function getCortexRecipientPublicKeyB64(cortexDir: string): Promise<string> {
  const edHex = await getOrCreateGezSigningKeyHex(cortexDir);
  return recipientPublicKeyB64FromEd25519(edHex);
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
  /**
   * Recipient-controlled confidentiality. When present, the pack is built in the
   * v2 format (`GEZ2`) and the payload is encrypted under a per-pack random CEK
   * wrapped per the option:
   *   - `{ passphrase }`        → Argon2id-derived CEK (shared out-of-band)
   *   - `{ recipientPubKeys }`  → CEK sealed to each X25519 recipient public key
   * Omit for the default signed-public v1 pack (obfuscation-only confidentiality).
   */
  encryptFor?: EncryptForOption;
}

export interface ExportEngramResult {
  /** The `.gez` file bytes, ready to write to disk. */
  pack: Buffer;
  /** Number of sources included. */
  sourceCount: number;
  /** Whether the pack was signed. */
  signed: boolean;
  /** True when the pack was built in the v2 (encrypted-for-recipient) format. */
  encrypted: boolean;
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
  const { signingKeyHex, exportedBy = 'unknown', encryptFor } = opts;

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

  // Recipient-controlled confidentiality uses the v2 format; the default stays
  // v1 (signed-public, obfuscation-only). Encryption and signature are orthogonal.
  const pack = encryptFor
    ? await buildGezPackageV2(payload, { ...(signingKeyHex ? { signingKeyHex } : {}), encrypt: encryptFor })
    : buildGezPackage(payload, signingKeyHex);
  return { pack, sourceCount: sources.length, signed: !!signingKeyHex, encrypted: !!encryptFor };
}

// ── importEngram ──────────────────────────────────────────────────────────────

export interface ImportEngramOptions {
  /**
   * Target engram ID to ingest sources into when `quarantine` is FALSE. If the
   * engram doesn't exist, it will be created with the pack's metadata. Defaults
   * to the pack's original engramId. Ignored when quarantine is on — quarantined
   * imports always land in a fresh per-batch quarantine engram.
   */
  targetEngramId?: string;
  /**
   * If true, skip sources whose sourceId already exists in the target engram.
   * If false, re-ingest them (content updates to matching sourceId).
   * Default: true. (Has no effect on quarantine landing — a fresh engram is empty.)
   */
  skipExisting?: boolean;
  /**
   * Embed function wrapper used for ingestion. If not provided, uses the
   * host's default embed path.
   */
  withEmbedding?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Land the import in a fresh per-batch QUARANTINE engram (executionAutonomyLevel
   * 'L0', sensitivityTier 'sensitive') instead of merging into a live target.
   * DEFAULT TRUE. The quarantine engram is excluded — at the host boundary — from
   * federated recall, the proactive watcher, cross-skill resolution, and the
   * default list_skills scope until the owner promotes individual items. Set to
   * FALSE only for the legacy trusted in-app merge path.
   */
  quarantine?: boolean;
  /** Origin pack filename / label recorded in the quarantine provenance block. */
  fromPack?: string;
  /** Passphrase for a v2 passphrase-encrypted pack. */
  passphrase?: string;
  /** Decryption keys for a v2 recipient-encrypted pack. */
  recipientDecrypt?: DecryptOptions;
}

/**
 * Import a `.gez` pack buffer into the local cortex.
 *
 * Decrypts the pack (v1 obfuscation OR v2 passphrase/recipient via the magic-byte
 * dispatcher), verifies its Ed25519 signature (non-fatal, reported), then — by
 * default — lands every source in a fresh per-batch QUARANTINE engram that is
 * invisible to AI recall/dispatch until the owner promotes individual items.
 *
 * Returns a full per-source outcome report plus the quarantine engram id.
 */
export async function importEngram(
  host: GraphnosisHost,
  packData: Buffer,
  opts: ImportEngramOptions = {},
): Promise<{ result: GezImportResult; payload: GezPayload }> {
  const decryptOpts: DecryptOptions = {
    ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
    ...(opts.recipientDecrypt ?? {}),
  };
  const { payload } = await parseGezPackageAny(packData, decryptOpts);
  const { skipExisting = true, withEmbedding, quarantine = true } = opts;

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

  // Quarantine: land in a FRESH per-batch engram, never the live target.
  // Non-quarantine: legacy trusted merge into the named/origin target.
  let targetId: string;
  let quarantineEngramId: string | undefined;
  if (quarantine) {
    targetId = `quarantine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    quarantineEngramId = targetId;
    await host.createGraph(targetId);
    await host.setGraphMetadata(targetId, {
      template: payload.engramTemplate as any,
      displayName: `Quarantine — ${payload.engramDisplayName}`,
      createdAt: Date.now(),
      // High sensitivity + L0 so even a misconfigured promotion can't auto-dispatch.
      sensitivityTier: 'sensitive',
      executionAutonomyLevel: 'L0',
      quarantine: {
        fromPack: opts.fromPack ?? payload.engramDisplayName,
        ...(payload.signerPublicKey ? { signerPublicKey: payload.signerPublicKey } : {}),
        verified: signatureVerified,
        importedAt: Date.now(),
        items: [],
      },
    });
  } else {
    targetId = opts.targetEngramId ?? payload.engramId;
    if (!host.listGraphs().includes(targetId)) {
      await host.createGraph(targetId);
      await host.setGraphMetadata(targetId, {
        template: payload.engramTemplate as any,
        displayName: payload.engramDisplayName,
        createdAt: Date.now(),
      });
    }
  }

  // Build set of existing sourceIds for skip logic
  const existing = new Set(
    skipExisting ? host.listSources(targetId).map((s) => s.sourceId) : [],
  );

  // Ingest sources
  const outcomes: GezImportResult['outcomes'] = [];
  const quarantineItems: Array<{ sourceId: string; state: 'quarantined' }> = [];
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
      if (quarantine) quarantineItems.push({ sourceId: rec.sourceId, state: 'quarantined' });
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

  // Record the per-item quarantine state in the engram metadata now that the
  // landed sourceIds are known.
  if (quarantine && quarantineEngramId) {
    const meta = host.getGraphMetadata(quarantineEngramId);
    if (meta?.quarantine) {
      await host.setGraphMetadata(quarantineEngramId, {
        ...meta,
        quarantine: { ...meta.quarantine, items: quarantineItems.map((it) => ({ ...it })) },
      });
    }
  }

  return {
    result: {
      imported, skipped, failed, outcomes, signatureVerified, unsigned,
      ...(quarantineEngramId ? { quarantineEngramId } : {}),
    },
    payload,
  };
}
