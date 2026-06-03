import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';
import { collectFilesNewerThan } from './local-file-util.js';

/**
 * Obsidian vault connector.
 *
 * Scans a local Obsidian vault directory for Markdown files modified since
 * the last pull and ingests them as memory nodes. No API key or credentials
 * required — Obsidian stores everything as plain .md files on disk.
 *
 * Required options:
 *   vaultPath: string  — absolute path to the Obsidian vault folder
 *
 * Optional options:
 *   maxFiles: number   — cap on files per pull (default 50)
 */
export class ObsidianConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get vaultPath(): string {
    const p = this.config.options['vaultPath'];
    if (typeof p !== 'string' || !p) throw new Error('obsidian connector requires options.vaultPath');
    return p;
  }

  private get maxFiles(): number {
    const n = this.config.options['maxFiles'];
    return typeof n === 'number' && n > 0 ? Math.floor(n) : 2000;
  }

  /** The vault folder the manager watches for live changes. */
  watchPaths(): string[] {
    return [this.vaultPath];
  }

  /** sourceRefs of every .md file currently on disk (for mirror-mode pruning). */
  async listCurrentSourceRefs(): Promise<string[]> {
    const files = await collectFilesNewerThan(this.vaultPath, 0, { ext: '.md', skipDirs: ['.obsidian'] });
    return files.map((f) => `obsidian:${this.config.id}:${path.relative(this.vaultPath, f.path)}`);
  }

  async pull(since?: Date, limit?: number): Promise<ConnectorEvent[]> {
    const sinceMs = since?.getTime() ?? 0;
    const cap = limit ?? this.maxFiles;
    const files = await collectFilesNewerThan(this.vaultPath, sinceMs, { ext: '.md', skipDirs: ['.obsidian'] });
    const events: ConnectorEvent[] = [];

    for (const f of files.slice(0, cap)) {
      try {
        const content = await readFile(f.path, 'utf8');
        if (!content.trim()) continue;
        const relativePath = path.relative(this.vaultPath, f.path);
        const label = path.basename(f.path, '.md');
        events.push({
          text: `# ${label}\n\n${content}`,
          sourceRef: `obsidian:${this.config.id}:${relativePath}`,
          label,
          mtimeMs: f.mtimeMs,
        });
      } catch {
        // Skip unreadable files
      }
    }

    return events;
  }
}
