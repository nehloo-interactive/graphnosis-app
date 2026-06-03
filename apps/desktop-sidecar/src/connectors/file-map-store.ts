// Connector file→source map (opt-in mirror mode).
//
// Local-file connectors are additive by default: ingesting a file never removes
// anything when the file is later deleted or modified (the cortex is durable
// memory, not a filesystem mirror). When a connector opts into `mirrorDeletes`,
// the manager needs to know which ingested SOURCE corresponds to which file so
// it can forget the source when the file vanishes (prune) or is replaced
// (update). The stored source ref doesn't encode the file path (ingestClip
// rewrites it), so we keep our own authoritative map here.
//
// Key: the connector's stable event sourceRef (e.g. "gbrain:<id>:<relpath>",
// which encodes the connector id + path). Value: the ingested sourceId.
// Stored encrypted next to the cortex, same pattern as the other side-tables.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

const { encrypt, decrypt } = crypto;

export class ConnectorFileMapStore {
  private readonly file: string;
  private readonly key: Uint8Array;
  private readonly salt: Uint8Array;
  private cache: Record<string, string> | null = null;

  constructor(opts: { cortexDir: string; key: Uint8Array; salt: Uint8Array }) {
    this.file = path.join(opts.cortexDir, 'connector-file-map.json.enc');
    this.key = opts.key;
    this.salt = opts.salt;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const bytes = await fs.readFile(this.file);
      const pt = await decrypt(new Uint8Array(bytes), this.key);
      const parsed = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>;
      this.cache = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.cache = {};
      else throw e;
    }
    return this.cache;
  }

  private async persist(map: Record<string, string>): Promise<void> {
    this.cache = map;
    const json = new TextEncoder().encode(JSON.stringify(map));
    const ct = await encrypt(json, this.key, this.salt);
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, Buffer.from(ct));
    await fs.rename(tmp, this.file);
  }

  /** Current sourceId mapped to a sourceRef, if any. */
  async get(sourceRef: string): Promise<string | undefined> {
    return (await this.load())[sourceRef];
  }

  async set(sourceRef: string, sourceId: string): Promise<void> {
    const map = await this.load();
    if (map[sourceRef] === sourceId) return;
    await this.persist({ ...map, [sourceRef]: sourceId });
  }

  async delete(sourceRef: string): Promise<void> {
    const map = await this.load();
    if (!(sourceRef in map)) return;
    const { [sourceRef]: _drop, ...rest } = map;
    await this.persist(rest);
  }

  /** All [sourceRef, sourceId] entries whose sourceRef begins with `prefix`
   *  (e.g. "gbrain:<connectorId>:") — the set owned by one connector. */
  async entriesForPrefix(prefix: string): Promise<Array<[string, string]>> {
    return Object.entries(await this.load()).filter(([ref]) => ref.startsWith(prefix));
  }
}
