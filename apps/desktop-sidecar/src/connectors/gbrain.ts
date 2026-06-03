import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';
import { collectFilesNewerThan } from './local-file-util.js';

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
    return typeof n === 'number' && n > 0 ? Math.floor(n) : 2000;
  }

  /** The repo folder the manager watches for live changes. */
  watchPaths(): string[] {
    return [this.repoPath];
  }

  /** sourceRefs of every .md file currently on disk (for mirror-mode pruning). */
  async listCurrentSourceRefs(): Promise<string[]> {
    const files = await collectFilesNewerThan(this.repoPath, 0, { ext: '.md', skipDirs: ['.git'] });
    return files.map((f) => `gbrain:${this.config.id}:${path.relative(this.repoPath, f.path)}`);
  }

  async pull(since?: Date, limit?: number): Promise<ConnectorEvent[]> {
    const sinceMs = since?.getTime() ?? 0;
    const cap = limit ?? this.maxFiles;
    const files = await collectFilesNewerThan(this.repoPath, sinceMs, { ext: '.md', skipDirs: ['.git'] });
    const events: ConnectorEvent[] = [];

    for (const f of files.slice(0, cap)) {
      try {
        const content = await readFile(f.path, 'utf8');
        if (!content.trim()) continue;
        const relativePath = path.relative(this.repoPath, f.path);
        const label = path.basename(f.path, '.md');
        events.push({
          text: `# ${label}\n\n${content}`,
          sourceRef: `gbrain:${this.config.id}:${relativePath}`,
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
