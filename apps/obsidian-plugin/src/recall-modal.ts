import { App, MarkdownView, Modal, Notice } from 'obsidian';
import type { GraphnosisClient } from './graphnosis-client';
import type { PluginSettings } from './settings';

export class RecallModal extends Modal {
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private debounceTimer: number | undefined;

  constructor(
    app: App,
    private readonly client: GraphnosisClient,
    private readonly settings: PluginSettings,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('graphnosis-recall-modal');

    this.inputEl = this.contentEl.createEl('input', {
      type: 'text',
      placeholder: 'Search your Graphnosis memory…',
      cls: 'graphnosis-search-input',
    });

    this.resultsEl = this.contentEl.createDiv({ cls: 'graphnosis-results' });

    this.inputEl.addEventListener('input', () => {
      window.clearTimeout(this.debounceTimer);
      const q = this.inputEl.value.trim();
      if (!q) {
        this.resultsEl.empty();
        return;
      }
      this.debounceTimer = window.setTimeout(() => void this.search(q), 400);
    });

    this.inputEl.focus();
  }

  onClose(): void {
    window.clearTimeout(this.debounceTimer);
    this.contentEl.empty();
  }

  private async search(query: string): Promise<void> {
    this.resultsEl.empty();
    const loading = this.resultsEl.createDiv({ cls: 'graphnosis-loading', text: 'Searching…' });

    let raw: string;
    try {
      raw = await this.client.recall(query, this.settings.maxRecallTokens);
    } catch (e) {
      loading.remove();
      this.resultsEl.createDiv({
        cls: 'graphnosis-error',
        text: `Error: ${(e as Error).message}`,
      });
      return;
    }

    loading.remove();

    if (!raw.trim() || raw === '(no results)') {
      this.resultsEl.createDiv({ cls: 'graphnosis-empty', text: 'No results found.' });
      return;
    }

    // Split recall response into paragraph blocks; each becomes a clickable card.
    const blocks = raw.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    for (const block of blocks) {
      const card = this.resultsEl.createDiv({ cls: 'graphnosis-card' });
      card.createEl('p', { text: block });
      card.addEventListener('click', () => {
        this.insertAtCursor(block);
        this.close();
      });
    }
  }

  private insertAtCursor(text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor) {
      view.editor.replaceSelection(text);
    } else {
      navigator.clipboard.writeText(text).then(() => {
        new Notice('Graphnosis: copied to clipboard (no active editor).');
      }).catch(() => {
        new Notice(`Graphnosis: ${text.slice(0, 80)}…`);
      });
    }
  }
}
