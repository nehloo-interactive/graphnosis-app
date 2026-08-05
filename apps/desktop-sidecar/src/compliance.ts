/**
 * Compliance Mode — Evidence Pack export, retention purge, point-in-time recall.
 *
 * PRIVACY: Evidence packs contain structural audit data only — no raw MCP queries,
 * no passphrase material, no encryption keys. Consent records are tier/client scoped.
 *
 * RETENTION + OBLIGATIONS: Per-source retention purge skips sources that still carry
 * an active obligation (expiresAt in the future). Legal hold continues to block all
 * mutating ops. Obligation expiry uses `expiresAt` — never `validUntil`.
 */

import { createHash, randomBytes } from 'node:crypto';
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
  skillRuns: { count: number; runs: import('./skill-runs.js').SkillRunListItem[] };
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

/**
 * What the graph actually did with one source, in a word.
 *
 * `purged: boolean` on its own cannot say "some of it is still here", and
 * `forgetSource` can come back having deleted only part of a source (the SDK
 * returns refusals, it never throws — see `host.forgetSource`). A two-valued
 * field forces that third outcome into one of the two lies: "purged" (content
 * still live) or "not purged" (content already destroyed).
 */
export type RetentionPurgeStatus =
  /** The graph destroyed every node of this source. */
  | 'purged'
  /** Some nodes destroyed, some REFUSED — refused content is still live. */
  | 'partially-purged'
  /** Nothing was destroyed: every delete refused, or the purge errored. */
  | 'not-purged'
  /** Dry run — this source is a candidate; nothing was attempted. */
  | 'candidate'
  /** Not attempted: legal hold, or an active obligation. */
  | 'skipped';

export interface RetentionPurgeItem {
  graphId: string;
  sourceId: string;
  ingestedAt: number;
  exported: boolean;
  /**
   * TRUE only when the graph destroyed EVERY node of the source. A partial
   * purge is `false` here and `partially-purged` in `purgeStatus`; never read
   * this field as "nothing survived" without checking `purgeStatus`.
   */
  purged: boolean;
  /** The honest outcome. Always present. */
  purgeStatus: RetentionPurgeStatus;
  /**
   * One sentence a regulator can read verbatim, leading with the outcome in
   * upper case. A partial purge must be legible as partial without anyone
   * having to compare two counts.
   */
  purgeStatement: string;
  /** Nodes the graph destroyed. Absent when nothing was attempted (dry run/skip). */
  purgedNodeCount?: number;
  /** Nodes the graph REFUSED to delete — still live in the engram. */
  refusedNodeCount?: number;
  /** Ids of the surviving nodes, so the refusal can be chased down. */
  refusedNodeIds?: string[];
  skippedReason?: string;
}

export interface RetentionPurgeResult {
  dryRun: boolean;
  complianceEnabled: boolean;
  items: RetentionPurgeItem[];
  /**
   * TRUE when at least one source was attempted and not fully destroyed.
   * A consumer that only renders `items.length` ("N sources affected") must
   * check this before presenting the run as a completed purge.
   */
  incomplete: boolean;
  /** Run-level sentence for headers, toasts and report covers. */
  summary: string;
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
    skillRuns: { count: pack.skillRuns.count },
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

  let skillRunRows = await host.skillRuns.listPublic();
  if (opts.since !== undefined || opts.until !== undefined) {
    skillRunRows = skillRunRows.filter((r) => {
      if (opts.since !== undefined && r.updatedAt < opts.since) return false;
      if (opts.until !== undefined && r.updatedAt > opts.until) return false;
      return true;
    });
  }
  if (opts.engram) {
    skillRunRows = skillRunRows.filter((r) => r.skillGraphId === opts.engram);
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
    skillRuns: { count: skillRunRows.length, runs: skillRunRows },
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

/** File extension for an export slice. `.enc` so the envelope is self-evident. */
export const RETENTION_SLICE_EXT = '.json.enc';

/**
 * Write the pre-purge export slice, ENCRYPTED with the cortex data key.
 *
 * This slice is the last copy of content that is destroyed one statement later,
 * and since it began carrying full node text rather than 200-char cuts, a
 * retention purge was leaving the complete plaintext of every destroyed memory
 * sitting in a plain `.json` file — the only unencrypted at-rest artifact in a
 * cortex where `.gai` graphs (`host.save`), skill snapshots
 * (`skill-snapshots.ts:111`) and the MCP audit ledger (`mcp-audit.ts:81`) are
 * all sealed. Same key, same envelope as those, so it is readable exactly by
 * whoever can already open the cortex.
 *
 * Mode 0600 inside a 0700 directory is kept as defence in depth, not as the
 * protection: file modes do not survive a copy to a backup or a support bundle.
 */
async function writeRetentionExportSlice(
  cortexDir: string,
  dataKey: Uint8Array,
  graphId: string,
  sourceId: string,
  slice: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(cortexDir, 'compliance-exports', String(Date.now()));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${graphId}__${sourceId}${RETENTION_SLICE_EXT}`);
  const plaintext = new TextEncoder().encode(JSON.stringify(slice, null, 2));
  const ct = await crypto.encrypt(plaintext, dataKey, randomBytes(16));
  await fs.writeFile(target, Buffer.from(ct), { mode: 0o600 });
}

/**
 * Read one export slice back.
 *
 * Exists because encrypting a write-only artifact would make the destruction
 * evidence unopenable, which is worse than the plaintext it replaced: the whole
 * point of "export before purge" is that someone can later read what was
 * destroyed. Before this, nothing in the repo read these files at all.
 */
export async function readRetentionExportSlice(
  file: string,
  dataKey: Uint8Array,
): Promise<Record<string, unknown>> {
  const blob = await fs.readFile(file);
  const plaintext = await crypto.decrypt(new Uint8Array(blob), dataKey);
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

/**
 * Write what the graph DID onto the record, in the words a regulator reads.
 *
 * `host.forgetSource` returns the set it actually deleted plus `refusedNodeIds`
 * — the SDK signals a declined correction by returning `{applied:false}`, never
 * by throwing. Anything that stamps `purged: true` from the mere absence of an
 * exception is asserting the destruction of content that may still be live.
 */
function stampPurgeOutcome(
  item: RetentionPurgeItem,
  purgedNodeCount: number,
  refusedNodeIds: readonly string[],
): void {
  const refused = refusedNodeIds.length;
  const total = purgedNodeCount + refused;
  item.purgedNodeCount = purgedNodeCount;
  item.refusedNodeCount = refused;

  if (refused === 0) {
    item.purged = true;
    item.purgeStatus = 'purged';
    item.purgeStatement =
      `PURGED — the memory engine destroyed all ${total} node(s) of this source; `
      + `no content from it remains in engram ${item.graphId}.`;
    return;
  }

  item.purged = false;
  item.refusedNodeIds = refusedNodeIds.slice();
  const ids = refusedNodeIds.join(', ');
  if (purgedNodeCount === 0) {
    item.purgeStatus = 'not-purged';
    item.purgeStatement =
      `NOT PURGED — the memory engine REFUSED all ${total} delete(s). No content was destroyed; `
      + `every node of this source is STILL PRESENT in engram ${item.graphId} (refused node ids: ${ids}).`;
    return;
  }
  item.purgeStatus = 'partially-purged';
  item.purgeStatement =
    `PARTIALLY PURGED — the memory engine destroyed ${purgedNodeCount} of ${total} node(s) and `
    + `REFUSED ${refused}. This source was NOT destroyed: ${refused} node(s) are STILL PRESENT `
    + `in engram ${item.graphId} (refused node ids: ${ids}).`;
}

/** Run-level headline. A partial run must never read as a completed purge. */
function summarizeRetentionRun(dryRun: boolean, items: readonly RetentionPurgeItem[]): {
  incomplete: boolean;
  summary: string;
} {
  const skipped = items.filter((i) => i.purgeStatus === 'skipped').length;
  const skippedTail = skipped > 0 ? `, ${skipped} skipped (legal hold or active obligation)` : '';
  if (dryRun) {
    const candidates = items.filter((i) => i.purgeStatus === 'candidate').length;
    return {
      incomplete: false,
      summary: `Dry run — ${candidates} source(s) past their retention TTL${skippedTail}. Nothing was destroyed.`,
    };
  }
  const attempted = items.filter((i) => i.purgeStatus !== 'candidate' && i.purgeStatus !== 'skipped');
  const destroyed = attempted.filter((i) => i.purged).length;
  const partial = attempted.filter((i) => i.purgeStatus === 'partially-purged').length;
  const refused = attempted.filter((i) => i.purgeStatus === 'not-purged').length;
  if (partial + refused === 0) {
    return {
      incomplete: false,
      summary: `Purge complete — ${destroyed} of ${attempted.length} source(s) destroyed${skippedTail}.`,
    };
  }
  return {
    incomplete: true,
    summary:
      `INCOMPLETE PURGE — only ${destroyed} of ${attempted.length} source(s) were destroyed`
      + `${partial > 0 ? `, ${partial} partially purged` : ''}`
      + `${refused > 0 ? `, ${refused} refused outright` : ''}${skippedTail}. `
      + `Content named in those records is STILL PRESENT — this run is not proof of destruction.`,
  };
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
    return {
      dryRun,
      complianceEnabled: false,
      items,
      incomplete: false,
      summary: 'Compliance retention is disabled — no source was examined and nothing was destroyed.',
    };
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
          exported: false, purged: false,
          purgeStatus: 'skipped', skippedReason: 'source-legal-hold',
          purgeStatement:
            'NOT PURGED — skipped: this source is under legal hold. Nothing was destroyed and all '
            + 'of its content is STILL PRESENT.',
        });
        continue;
      }
      if (host.obligationIndex.hasActiveForSource(graphId, src.sourceId, now)) {
        items.push({
          graphId, sourceId: src.sourceId, ingestedAt: src.ingestedAt,
          exported: false, purged: false,
          purgeStatus: 'skipped', skippedReason: 'active-obligation',
          purgeStatement:
            'NOT PURGED — skipped: this source still carries an active obligation. Nothing was '
            + 'destroyed and all of its content is STILL PRESENT.',
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
        purgeStatus: 'candidate',
        purgeStatement:
          'NOT PURGED — dry run: this source is past its retention TTL and would be purged. '
          + 'Nothing was destroyed.',
      };

      if (dryRun) {
        items.push(item);
        continue;
      }

      if (shouldExportBeforePurge(metadata, compliance)) {
        // This slice is the proof-of-content artifact a regulator reads AFTER
        // the source has been destroyed, so it is the last copy and has to
        // hold the content itself.
        //
        // It used to store `contentPreview.slice(0, 200)` — a 200-char cut of
        // a value `graphnosis-impl.ts:954` has already capped at 497 — so
        // "export before purge" was false for any node over 200 characters,
        // and the shortfall was invisible because the very next statement
        // (`forgetSource`) destroyed the only thing it could be compared
        // against. `getFullNodeContent` is the correct reader; the same
        // codebase already uses it for exports at `engram-pack.ts:190`.
        //
        // Reading each node directly also removes an O(n²) `listNodes()` call
        // that ran once per node and scanned the whole engram each time.
        const nodes: Array<{ nodeId: string; content?: string }> = [];
        for (const nodeId of src.nodeIds) {
          const content = host.getFullNodeContent(graphId, nodeId);
          nodes.push({ nodeId, ...(content ? { content } : {}) });
        }
        await writeRetentionExportSlice(cortexDir, host.getCortexDataKey(), graphId, src.sourceId, {
          exportedAt: Date.now(),
          graphId,
          sourceId: src.sourceId,
          ref: src.ref,
          kind: src.kind,
          ingestedAt: src.ingestedAt,
          nodeCount: src.nodeIds.length,
          nodes,
        });
        item.exported = true;
      }

      // `forgetSource` returns what it DID: `nodeIds` is the deleted set and
      // `refusedNodeIds` names the nodes the engine declined to delete — which
      // are left LIVE, with the source record restored around them. Stamping
      // `purged: true` on the absence of a throw asserted a destruction that
      // never happened, on the one artifact produced as proof of destruction.
      try {
        const forgotten = await host.forgetSource(graphId, src.sourceId, { triggeredBy: 'compliance:retention' });
        stampPurgeOutcome(item, forgotten.nodeIds.length, forgotten.refusedNodeIds ?? []);
        if (!item.purged) {
          console.error(
            `[compliance] retention purge of ${graphId}/${src.sourceId}: ${item.purgeStatement}`,
          );
        }
      } catch (e: unknown) {
        // A throw mid-sweep used to abandon the whole run, losing the record of
        // every source already destroyed. Record the failure and carry on: an
        // unpurged source with a record saying so beats no record at all.
        const msg = e instanceof Error ? e.message : String(e);
        item.purged = false;
        item.purgeStatus = 'not-purged';
        item.purgeStatement =
          `NOT PURGED — the purge of this source FAILED (${msg}). Treat every node of this source `
          + `as STILL PRESENT in engram ${graphId} until a later run reports otherwise.`;
        console.error(`[compliance] retention purge of ${graphId}/${src.sourceId} failed: ${msg}`);
      }
      items.push(item);
    }
  }

  return { dryRun, complianceEnabled: true, items, ...summarizeRetentionRun(dryRun, items) };
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
