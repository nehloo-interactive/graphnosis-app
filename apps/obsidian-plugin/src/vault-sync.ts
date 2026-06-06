import type { TFile, Vault } from 'obsidian';
import type { GraphnosisClient } from './graphnosis-client';
import type { PluginSettings } from './settings';

export class VaultSync {
  private queue: Map<string, TFile> = new Map();
  private timer: number | undefined;

  constructor(
    private readonly vault: Vault,
    private readonly client: GraphnosisClient,
    private readonly settings: PluginSettings,
    private readonly onSyncAt: (ts: number) => Promise<void>,
  ) {}

  enqueue(file: TFile): void {
    if (file.path.startsWith('.obsidian/') || !file.path.endsWith('.md')) return;
    this.queue.set(file.path, file);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 5_000);
  }

  /** Queue all .md files modified after `since` (Unix ms). Runs in the background. */
  async catchUp(since: number): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    for (const file of files) {
      if (file.path.startsWith('.obsidian/')) continue;
      if (file.stat.mtime > since) {
        this.queue.set(file.path, file);
      }
    }
    if (this.queue.size > 0) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.flush(), 5_000);
    }
  }

  private async flush(): Promise<void> {
    if (!this.queue.size) return;

    const files = [...this.queue.values()];
    this.queue.clear();

    for (let i = 0; i < files.length; i += 20) {
      const chunk = files.slice(i, i + 20);
      const items: Array<{ text: string; label: string; target_engram: string }> = [];

      for (const file of chunk) {
        try {
          const content = await this.vault.read(file);
          if (!content.trim()) continue;
          items.push({
            text: `# ${file.basename}\n\n${content}`,
            label: file.basename,
            target_engram: this.settings.vaultSyncEngram,
          });
        } catch {
          // Skip unreadable files silently
        }
      }

      if (items.length === 0) continue;

      try {
        await this.client.ingestBatch(items);
      } catch {
        // Re-enqueue on failure so we retry next save cycle
        for (const file of chunk) this.queue.set(file.path, file);
        return;
      }
    }

    await this.onSyncAt(Date.now());
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.queue.clear();
  }
}
