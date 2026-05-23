import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * AI context files connector.
 *
 * Scans project directories for standard AI assistant context files and
 * ingests them into the cortex. Covers Claude Code (CLAUDE.md), Cursor
 * (.cursorrules), GitHub Copilot (.github/copilot-instructions.md),
 * OpenAI Agents (AGENTS.md), Windsurf (.windsurfrules), and more.
 *
 * Required options:
 *   paths: string[]  — list of project / home directory paths to scan
 *
 * The global ~/.claude/CLAUDE.md is always included automatically.
 */

const CONTEXT_FILENAMES: string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'MEMORY.md',
  '.cursorrules',
  'CURSOR_RULES',
  'GEMINI.md',
  '.windsurfrules',
  '.github/copilot-instructions.md',
];

const CURSOR_RULES_DIR = '.cursor/rules';

export class AiContextConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get paths(): string[] {
    const p = this.config.options['paths'];
    const configured: string[] = Array.isArray(p) ? (p as string[]).filter(Boolean) : [];
    // Always include the global ~/.claude directory
    const globalClaude = path.join(os.homedir(), '.claude');
    if (!configured.includes(globalClaude)) configured.unshift(globalClaude);
    return configured;
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const sinceMs = since?.getTime() ?? 0;
    const events: ConnectorEvent[] = [];

    for (const dir of this.paths) {
      // Standard known filenames
      for (const filename of CONTEXT_FILENAMES) {
        const filePath = path.join(dir, filename);
        const event = await this.tryIngest(filePath, dir, sinceMs);
        if (event) events.push(event);
      }
      // .cursor/rules/*.md — directory of rule files
      const cursorRulesDir = path.join(dir, CURSOR_RULES_DIR);
      try {
        const entries = await readdir(cursorRulesDir);
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue;
          const filePath = path.join(cursorRulesDir, entry);
          const event = await this.tryIngest(filePath, dir, sinceMs);
          if (event) events.push(event);
        }
      } catch {
        // Directory doesn't exist — fine
      }
    }

    return events;
  }

  private async tryIngest(
    filePath: string,
    projectRoot: string,
    sinceMs: number,
  ): Promise<ConnectorEvent | null> {
    try {
      const s = await stat(filePath);
      if (!s.isFile() || s.mtimeMs <= sinceMs) return null;
      const content = await readFile(filePath, 'utf8');
      if (!content.trim()) return null;
      const relativePath = path.relative(projectRoot, filePath);
      const projectName = path.basename(projectRoot);
      const label = `${relativePath} (${projectName})`;
      return {
        text: `# ${relativePath}\n_Project: ${projectRoot}_\n\n${content}`,
        sourceRef: `ai-context:${this.config.id}:${filePath}`,
        label,
      };
    } catch {
      return null;
    }
  }
}
