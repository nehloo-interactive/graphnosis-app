import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { GraphnosisPlugin } from './main';

export interface PluginSettings {
  httpBridgeUrl: string;
  bearerToken: string;
  vaultSync: boolean;
  vaultSyncEngram: string;
  maxRecallTokens: number;
  lastSyncAt: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  httpBridgeUrl: 'http://127.0.0.1:3457/mcp',
  bearerToken: '',
  vaultSync: false,
  vaultSyncEngram: 'personal',
  maxRecallTokens: 2000,
  lastSyncAt: 0,
};

export class GraphnosisSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GraphnosisPlugin) {
    super(app, plugin as unknown as Plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Graphnosis' });

    new Setting(containerEl)
      .setName('HTTP bridge URL')
      .setDesc('URL of the Graphnosis local MCP bridge. Matches Graphnosis → Settings → VS Code.')
      .addText(text => text
        .setPlaceholder('http://127.0.0.1:3457/mcp')
        .setValue(this.plugin.settings.httpBridgeUrl)
        .onChange(async (value) => {
          this.plugin.settings.httpBridgeUrl = value.trim() || DEFAULT_SETTINGS.httpBridgeUrl;
          await this.plugin.saveAndApply();
        }));

    new Setting(containerEl)
      .setName('Bearer token')
      .setDesc('Copy from Graphnosis app → Settings → VS Code tab.')
      .addText(text => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
          .setValue(this.plugin.settings.bearerToken)
          .onChange(async (value) => {
            this.plugin.settings.bearerToken = value.trim();
            await this.plugin.saveAndApply();
          });
      });

    new Setting(containerEl)
      .setName('Connection')
      .setDesc('Verify the bridge is reachable with the current token.')
      .addButton(btn => btn
        .setButtonText('Test connection')
        .onClick(async () => {
          if (!this.plugin.client) {
            new Notice('Graphnosis: enter a bearer token first.');
            return;
          }
          const ok = await this.plugin.client.ping();
          new Notice(ok
            ? 'Graphnosis: connected!'
            : 'Graphnosis: bridge not reachable — is the Graphnosis app running?');
        }));

    containerEl.createEl('h3', { text: 'Vault sync' });

    new Setting(containerEl)
      .setName('Enable vault sync')
      .setDesc('Push modified notes to Graphnosis memory on save. On startup, catches up any notes modified while Obsidian was closed.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.vaultSync)
        .onChange(async (value) => {
          this.plugin.settings.vaultSync = value;
          await this.plugin.saveAndApply();
          this.display();
        }));

    if (this.plugin.settings.vaultSync) {
      new Setting(containerEl)
        .setName('Target engram')
        .setDesc('Which Graphnosis engram (graph) to sync notes into.')
        .addText(text => text
          .setPlaceholder('personal')
          .setValue(this.plugin.settings.vaultSyncEngram)
          .onChange(async (value) => {
            this.plugin.settings.vaultSyncEngram = value.trim() || DEFAULT_SETTINGS.vaultSyncEngram;
            await this.plugin.saveData(this.plugin.settings);
          }));
    }

    containerEl.createEl('h3', { text: 'Recall' });

    new Setting(containerEl)
      .setName('Max recall tokens')
      .setDesc('Token budget passed to each recall query.')
      .addSlider(slider => slider
        .setLimits(100, 8000, 100)
        .setValue(this.plugin.settings.maxRecallTokens)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxRecallTokens = value;
          await this.plugin.saveData(this.plugin.settings);
        }));
  }
}
