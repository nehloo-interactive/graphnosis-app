import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

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
    return typeof n === 'number' && n > 0 ? Math.floor(n) : 50;
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const sinceMs = since?.getTime() ?? 0;
    const files = await this.collectMarkdownFiles(this.vaultPath, sinceMs);
    const events: ConnectorEvent[] = [];

    for (const filePath of files.slice(0, this.maxFiles)) {
      try {
        const content = await readFile(filePath, 'utf8');
        if (!content.trim()) continue;
        const relativePath = path.relative(this.vaultPath, filePath);
        const label = path.basename(filePath, '.md');
        events.push({
          text: `# ${label}\n\n${content}`,
          sourceRef: `obsidian:${this.config.id}:${relativePath}`,
          label,
        });
      } catch {
        // Skip unreadable files
      }
    }

    return events;
  }

  private async collectMarkdownFiles(dir: string, sinceMs: number): Promise<string[]> {
    const results: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      // Skip Obsidian's internal .obsidian config directory
      if (entry === '.obsidian' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          results.push(...await this.collectMarkdownFiles(full, sinceMs));
        } else if (entry.endsWith('.md') && s.mtimeMs > sinceMs) {
          results.push(full);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
    return results;
  }
}
