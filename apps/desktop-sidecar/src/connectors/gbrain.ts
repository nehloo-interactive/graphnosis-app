import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * GBrain connector.
 *
 * GBrain stores knowledge as Markdown files in a local git repository,
 * optionally synced to a PostgreSQL/PGLite database via MCP. This connector
 * reads the Markdown files directly — no database or API key required.
 *
 * Required options:
 *   repoPath: string   — absolute path to the GBrain git repo folder
 *
 * Optional options:
 *   maxFiles: number   — cap on files per pull (default 50)
 */
export class GBrainConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get repoPath(): string {
    const p = this.config.options['repoPath'];
    if (typeof p !== 'string' || !p) throw new Error('gbrain connector requires options.repoPath');
    return p;
  }

  private get maxFiles(): number {
    const n = this.config.options['maxFiles'];
    return typeof n === 'number' && n > 0 ? Math.floor(n) : 50;
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const sinceMs = since?.getTime() ?? 0;
    const files = await this.collectMarkdownFiles(this.repoPath, sinceMs);
    const events: ConnectorEvent[] = [];

    for (const filePath of files.slice(0, this.maxFiles)) {
      try {
        const content = await readFile(filePath, 'utf8');
        if (!content.trim()) continue;
        const relativePath = path.relative(this.repoPath, filePath);
        const label = path.basename(filePath, '.md');
        events.push({
          text: `# ${label}\n\n${content}`,
          sourceRef: `gbrain:${this.config.id}:${relativePath}`,
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
      // Skip git internals and hidden dirs
      if (entry === '.git' || entry.startsWith('.')) continue;
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
