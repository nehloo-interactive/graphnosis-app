import { Notice, Plugin, TFile } from 'obsidian';
import { GraphnosisClient } from './graphnosis-client';
import { DEFAULT_SETTINGS, GraphnosisSettingTab, type PluginSettings } from './settings';
import { RecallModal } from './recall-modal';
import { VaultSync } from './vault-sync';

export class GraphnosisPlugin extends Plugin {
  settings!: PluginSettings;
  client: GraphnosisClient | null = null;
  private statusBarEl!: HTMLElement;
  private vaultSync: VaultSync | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.buildClient();

    this.addCommand({
      id: 'recall',
      name: 'Search Graphnosis memory…',
      callback: () => {
        if (!this.client) {
          new Notice('Graphnosis: configure bearer token first (Settings → Graphnosis).');
          return;
        }
        new RecallModal(this.app, this.client, this.settings).open();
      },
    });

    this.addCommand({
      id: 'remember',
      name: 'Save current note to Graphnosis memory',
      editorCallback: (editor) => {
        const label = this.app.workspace.getActiveFile()?.basename;
        void this.rememberNote(editor.getValue(), label);
      },
    });

    this.addSettingTab(new GraphnosisSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText('G');
    this.statusBarEl.title = 'Graphnosis (checking…)';
    void this.refreshStatusBar();

    this.registerInterval(window.setInterval(() => void this.refreshStatusBar(), 60_000));

    // Always register vault events; VaultSync handles queuing only when active.
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file instanceof TFile) this.vaultSync?.enqueue(file);
    }));
    this.registerEvent(this.app.vault.on('create', (file) => {
      if (file instanceof TFile) this.vaultSync?.enqueue(file);
    }));

    if (this.settings.vaultSync) {
      this.startVaultSync();
      void this.vaultSync?.catchUp(this.settings.lastSyncAt);
    }

    if (!this.settings.bearerToken) {
      new Notice('Graphnosis: open Settings → Graphnosis to paste your bearer token.');
    }
  }

  onunload(): void {
    this.vaultSync?.destroy();
  }

  buildClient(): void {
    this.client = this.settings.bearerToken
      ? new GraphnosisClient(this.settings.httpBridgeUrl, this.settings.bearerToken)
      : null;
  }

  async refreshStatusBar(): Promise<void> {
    if (!this.client) {
      this.statusBarEl.setText('G');
      this.statusBarEl.title = 'Graphnosis — not connected';
      this.statusBarEl.removeClass('graphnosis-healthy', 'graphnosis-degraded');
      return;
    }
    const score = await this.client.vitality();
    if (score === null) {
      this.statusBarEl.setText('G');
      this.statusBarEl.title = 'Graphnosis — bridge unreachable';
      this.statusBarEl.removeClass('graphnosis-healthy', 'graphnosis-degraded');
    } else {
      this.statusBarEl.setText('G');
      this.statusBarEl.title = `Graphnosis — cortex vitality ${score}/100`;
      this.statusBarEl.toggleClass('graphnosis-healthy', score >= 60);
      this.statusBarEl.toggleClass('graphnosis-degraded', score < 60);
    }
  }

  startVaultSync(): void {
    if (!this.client) return;
    this.vaultSync = new VaultSync(
      this.app.vault,
      this.client,
      this.settings,
      async (ts) => {
        this.settings.lastSyncAt = ts;
        await this.saveData(this.settings);
      },
    );
  }

  stopVaultSync(): void {
    this.vaultSync?.destroy();
    this.vaultSync = undefined;
  }

  async rememberNote(content: string, label?: string): Promise<void> {
    if (!this.client) {
      new Notice('Graphnosis: not connected.');
      return;
    }
    try {
      await this.client.remember(content, label);
      new Notice('Saved to Graphnosis memory.');
    } catch (e) {
      new Notice(`Graphnosis: save failed — ${(e as Error).message}`);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PluginSettings>);
  }

  async saveAndApply(): Promise<void> {
    await this.saveData(this.settings);
    this.buildClient();
    if (this.settings.vaultSync && !this.vaultSync) {
      this.startVaultSync();
    } else if (!this.settings.vaultSync && this.vaultSync) {
      this.stopVaultSync();
    }
    // Re-read this.vaultSync after the possible mutation above.
    if (this.settings.vaultSync && this.vaultSync) {
      void this.vaultSync.catchUp(this.settings.lastSyncAt);
    }
    void this.refreshStatusBar();
  }
}

export default GraphnosisPlugin;
