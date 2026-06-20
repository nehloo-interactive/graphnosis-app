/**
 * Compliance Mode — Evidence Pack export, retention purge, point-in-time recall.
 *
 * PRIVACY: Evidence packs contain structural audit data only — no raw MCP queries,
 * no passphrase material, no encryption keys. Consent records are tier/client scoped.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto, oplog } from '@nehloo-interactive/graphnosis-secure-sync';
import {
  isRetentionExpired,
  retentionTtlMsForGraph,
  shouldExportBeforePurge,
  isEngramOnLegalHold,
} from '@graphnosis-app/core';
import type { GraphnosisHost } from './host.js';
import type { McpAuditEvent } from './mcp-audit.js';

export interface EvidencePackOptions {
  since?: number;
  until?: number;
  engram?: string;
}

export interface EvidencePackSignature {
  algorithm: 'Ed25519';
  signer: 'device' | 'org';
  deviceId?: string;
  publicKey: string;
  signature: string;
  manifestHash: string;
}

export interface EvidencePack {
  version: 1;
  exportedAt: number;
  window: { since?: number; until?: number; engram?: string };
  oplog: { count: number; events: Awaited<ReturnType<GraphnosisHost['listOplogEvents']>> };
  consent: { count: number; records: NonNullable<ReturnType<GraphnosisHost['getSettings']>['ai']['dataAccessConsents']> };
  mcpAudit: { count: number; events: McpAuditEvent[] };
  engramHashes: Array<{ graphId: string; gaiSha256: string; bundleSha256?: string }>;
  manifestHash?: string;
  signatures?: EvidencePackSignature[];
}

export interface SignedEvidencePackExport {
  pack: EvidencePack;
  manifestHash: string;
  signatures: EvidencePackSignature[];
  /** Detached .sig payload (same as signatures, for dual-file export). */
  detachedSig: { manifestHash: string; signatures: EvidencePackSignature[] };
}

export interface RetentionPurgeItem {
  graphId: string;
  sourceId: string;
  ingestedAt: number;
  exported: boolean;
  purged: boolean;
  skippedReason?: string;
}

export interface RetentionPurgeResult {
  dryRun: boolean;
  complianceEnabled: boolean;
  items: RetentionPurgeItem[];
}

export interface RecallAsOfMatch {
  nodeId: string;
  preview: string;
  sourceId?: string;
  ts?: number;
}

export interface RecallAsOfResult {
  asOfBoundary: { seq?: number; ts?: number };
  graphId?: string;
  query: string;
  matches: RecallAsOfMatch[];
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

function filterEventsByWindow<T extends { ts: number }>(
  events: T[],
  since?: number,
  until?: number,
): T[] {
  let out = events;
  if (since !== undefined) out = out.filter((ev) => ev.ts >= since);
  if (until !== undefined) out = out.filter((ev) => ev.ts <= until);
  return out;
}

async function sha256File(filePath: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(filePath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return undefined;
  }
}

function manifestHashForPack(pack: Omit<EvidencePack, 'manifestHash' | 'signatures'>): string {
  const canonical = JSON.stringify({
    version: pack.version,
    exportedAt: pack.exportedAt,
    window: pack.window,
    oplog: { count: pack.oplog.count },
    consent: { count: pack.consent.count },
    mcpAudit: { count: pack.mcpAudit.count },
    engramHashes: pack.engramHashes,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function signManifestHash(
  manifestHash: string,
  signers: Array<{
    kind: 'device' | 'org';
    deviceId?: string;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }>,
): Promise<EvidencePackSignature[]> {
  const message = new TextEncoder().encode(manifestHash);
  const out: EvidencePackSignature[] = [];
  for (const s of signers) {
    const signature = await crypto.sign(message, s.secretKey);
    out.push({
      algorithm: 'Ed25519',
      signer: s.kind,
      ...(s.deviceId ? { deviceId: s.deviceId } : {}),
      publicKey: b64(s.publicKey),
      signature: b64(signature),
      manifestHash,
    });
  }
  return out;
}

export async function verifyEvidencePackSignature(sig: EvidencePackSignature): Promise<boolean> {
  if (sig.algorithm !== 'Ed25519') return false;
  const message = new TextEncoder().encode(sig.manifestHash);
  return crypto.verify(unb64(sig.signature), message, unb64(sig.publicKey));
}

export async function buildEvidencePack(
  host: GraphnosisHost,
  cortexDir: string,
  opts: EvidencePackOptions = {},
): Promise<EvidencePack> {
  let events = await host.listOplogEvents();
  events = filterEventsByWindow(events, opts.since, opts.until);
  if (opts.engram) events = events.filter((ev) => ev.graphId === opts.engram);
  events = events.slice().sort((a, b) => a.ts - b.ts);

  let mcpEvents = await host.listMcpAuditEvents();
  mcpEvents = filterEventsByWindow(mcpEvents, opts.since, opts.until);
  if (opts.engram) {
    mcpEvents = mcpEvents.filter((ev) => ev.engramIds?.includes(opts.engram!) ?? false);
  }
  mcpEvents = mcpEvents.slice().sort((a, b) => a.ts - b.ts);

  const consents = host.getSettings().ai.dataAccessConsents ?? [];
  let consentSlice = consents;
  if (opts.since !== undefined || opts.until !== undefined) {
    consentSlice = consents.filter((c) => {
      const t = c.grantedAt ?? c.expiresAt ?? 0;
      if (opts.since !== undefined && t < opts.since) return false;
      if (opts.until !== undefined && t > opts.until) return false;
      return true;
    });
  }

  const graphsDir = path.join(cortexDir, 'graphs');
  const engramHashes: EvidencePack['engramHashes'] = [];
  try {
    const files = await fs.readdir(graphsDir);
    for (const f of files) {
      if (!f.endsWith('.gai')) continue;
      const graphId = f.slice(0, -4);
      if (opts.engram && graphId !== opts.engram) continue;
      const gaiSha256 = await sha256File(path.join(graphsDir, f));
      if (!gaiSha256) continue;
      const bundleSha256 = await sha256File(path.join(graphsDir, `${graphId}.bundle`));
      engramHashes.push({ graphId, gaiSha256, ...(bundleSha256 ? { bundleSha256 } : {}) });
    }
  } catch {
    // graphs dir may not exist on fresh cortex
  }

  return {
    version: 1,
    exportedAt: Date.now(),
    window: {
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.until !== undefined ? { until: opts.until } : {}),
      ...(opts.engram !== undefined ? { engram: opts.engram } : {}),
    },
    oplog: { count: events.length, events },
    consent: { count: consentSlice.length, records: consentSlice },
    mcpAudit: { count: mcpEvents.length, events: mcpEvents },
    engramHashes,
  };
}

export async function buildSignedEvidencePack(
  host: GraphnosisHost,
  cortexDir: string,
  opts: EvidencePackOptions = {},
): Promise<SignedEvidencePackExport> {
  const pack = await buildEvidencePack(host, cortexDir, opts);
  const manifestHash = manifestHashForPack(pack);
  const signers = host.getEvidencePackSigners();
  const signatures = signers.length > 0
    ? await signManifestHash(manifestHash, signers)
    : [];
  const signedPack: EvidencePack = { ...pack, manifestHash, signatures };
  const detachedSig = { manifestHash, signatures };
  return { pack: signedPack, manifestHash, signatures, detachedSig };
}

async function writeRetentionExportSlice(
  cortexDir: string,
  graphId: string,
  sourceId: string,
  slice: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(cortexDir, 'compliance-exports', String(Date.now()));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${graphId}__${sourceId}.json`);
  await fs.writeFile(target, JSON.stringify(slice, null, 2), { mode: 0o600 });
}

export async function runRetentionPurge(
  host: GraphnosisHost,
  cortexDir: string,
  dryRun = false,
): Promise<RetentionPurgeResult> {
  const settings = host.getSettings();
  const compliance = settings.compliance;
  const complianceEnabled = compliance?.enabled === true;
  const items: RetentionPurgeItem[] = [];

  if (!complianceEnabled) {
    return { dryRun, complianceEnabled: false, items };
  }

  const graphs = host.graphsWithMetadata();
  const now = Date.now();

  for (const { graphId, metadata } of graphs) {
    if (isEngramOnLegalHold(metadata)) continue;
    const ttlMs = retentionTtlMsForGraph(metadata, compliance);
    if (ttlMs === undefined) continue;

    let sources: ReturnType<GraphnosisHost['listSources']>;
    try {
      sources = host.listSources(graphId);
    } catch {
      continue;
    }

    for (const src of sources) {
      if (src.legalHold) {
        items.push({
          graphId, sourceId: src.sourceId, ingestedAt: src.ingestedAt,
          exported: false, purged: false, skippedReason: 'source-legal-hold',
        });
        continue;
      }
      if (!isRetentionExpired(src.ingestedAt, ttlMs, src.legalHold, now)) continue;

      const item: RetentionPurgeItem = {
        graphId,
        sourceId: src.sourceId,
        ingestedAt: src.ingestedAt,
        exported: false,
        purged: false,
      };

      if (dryRun) {
        items.push(item);
        continue;
      }

      if (shouldExportBeforePurge(metadata, compliance)) {
        const previews: Array<{ nodeId: string; preview?: string }> = [];
        for (const nodeId of src.nodeIds) {
          const preview = host.listNodes(graphId).find((n) => n.id === nodeId)?.contentPreview;
          previews.push({ nodeId, ...(preview ? { preview: preview.slice(0, 200) } : {}) });
        }
        await writeRetentionExportSlice(cortexDir, graphId, src.sourceId, {
          exportedAt: Date.now(),
          graphId,
          sourceId: src.sourceId,
          ref: src.ref,
          kind: src.kind,
          ingestedAt: src.ingestedAt,
          nodeCount: src.nodeIds.length,
          nodePreviews: previews,
        });
        item.exported = true;
      }

      await host.forgetSource(graphId, src.sourceId, { triggeredBy: 'compliance:retention' });
      item.purged = true;
      items.push(item);
    }
  }

  return { dryRun, complianceEnabled: true, items };
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function scoreContent(content: string, tokens: string[]): number {
  const lower = content.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (lower.includes(t)) hits++;
  }
  return hits;
}

export async function recallAsOf(
  host: GraphnosisHost,
  query: string,
  opts: { graphId?: string; asOfSeq?: number; asOfTs?: number; maxNodes?: number },
): Promise<RecallAsOfResult> {
  if (opts.asOfSeq === undefined && opts.asOfTs === undefined) {
    throw new Error('recall_as_of requires as_of_seq or as_of_ts');
  }

  let events = await host.listOplogEvents();
  if (opts.asOfSeq !== undefined) {
    events = events.filter((ev) => (ev.seq ?? Number.MAX_SAFE_INTEGER) <= opts.asOfSeq!);
  }
  if (opts.asOfTs !== undefined) {
    events = events.filter((ev) => ev.ts <= opts.asOfTs!);
  }
  if (opts.graphId) {
    events = events.filter((ev) => ev.graphId === opts.graphId);
  }

  const reduced = oplog.reduce(events);
  const tokens = tokenizeQuery(query);
  const maxNodes = Math.min(Math.max(opts.maxNodes ?? 20, 1), 50);
  const matches: RecallAsOfMatch[] = [];

  for (const [graphId, state] of reduced) {
    if (opts.graphId && graphId !== opts.graphId) continue;
    for (const [nodeId, entry] of state.nodes) {
      const data = entry.data as { content?: string; sourceId?: string; preview?: string } | undefined;
      const text = typeof data?.content === 'string'
        ? data.content
        : typeof data?.preview === 'string'
          ? data.preview
          : '';
      if (!text) continue;
      const score = tokens.length > 0 ? scoreContent(text, tokens) : 1;
      if (tokens.length > 0 && score === 0) continue;
      matches.push({
        nodeId,
        preview: text.slice(0, 240),
        ...(data?.sourceId ? { sourceId: data.sourceId } : {}),
        ts: entry.ts,
      });
    }
  }

  matches.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return {
    asOfBoundary: {
      ...(opts.asOfSeq !== undefined ? { seq: opts.asOfSeq } : {}),
      ...(opts.asOfTs !== undefined ? { ts: opts.asOfTs } : {}),
    },
    ...(opts.graphId ? { graphId: opts.graphId } : {}),
    query,
    matches: matches.slice(0, maxNodes),
  };
}

export function compactionManifestHash(record: {
  at: number;
  eventsRemoved: number;
  eventsBefore: number;
  eventsAfter: number;
  bytesBefore?: number;
  bytesAfter?: number;
}): string {
  const canonical = JSON.stringify({
    at: record.at,
    eventsRemoved: record.eventsRemoved,
    eventsBefore: record.eventsBefore,
    eventsAfter: record.eventsAfter,
    bytesBefore: record.bytesBefore ?? null,
    bytesAfter: record.bytesAfter ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
