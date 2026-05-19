import * as vscode from 'vscode';
import { GraphnosisClient } from './graphnosis-client';
import { getConfig } from './config';
import { registerParticipant } from './participant';
import { registerLmTools } from './auto-inject';
import { registerRememberFlow } from './remember-flow';

let client: GraphnosisClient | null = null;

function buildClient(): GraphnosisClient | null {
  const cfg = getConfig();
  if (!cfg.bearerToken) return null;
  return new GraphnosisClient(cfg.httpBridgeUrl, cfg.bearerToken);
}

export function activate(context: vscode.ExtensionContext): void {
  client = buildClient();

  // Rebuild client whenever relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('graphnosis.bearerToken') ||
          e.affectsConfiguration('graphnosis.httpBridgeUrl')) {
        client = buildClient();
      }
    }),
  );

  // One-time setup wizard — walks the user through pasting the bearer token.
  context.subscriptions.push(
    vscode.commands.registerCommand('graphnosis.configure', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Connect Graphnosis',
        prompt: 'Paste the bearer token from Graphnosis → Settings → VS Code',
        placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        password: true,
        ignoreFocusOut: true,
      });
      if (!token) return;

      await vscode.workspace.getConfiguration('graphnosis').update(
        'bearerToken', token.trim(), vscode.ConfigurationTarget.Global,
      );
      client = buildClient();

      const ok = await client?.ping();
      if (ok) {
        void vscode.window.showInformationMessage(
          'Graphnosis: connected! Try asking Copilot about your projects.',
        );
      } else {
        void vscode.window.showWarningMessage(
          'Graphnosis: token saved, but the bridge is not responding. ' +
          'Make sure Graphnosis is running and the cortex is unlocked.',
        );
      }
    }),
  );

  // @graphnosis chat participant — explicit invocation, all supported VS Code versions.
  registerParticipant(context, () => client);

  // graphnosis_recall + graphnosis_remember LM tools — auto-injection (VS Code 1.97+).
  context.subscriptions.push(...registerLmTools(() => client));

  // "Save to memory" command + status bar hint after large Copilot insertions.
  context.subscriptions.push(...registerRememberFlow(context, () => client));

  // Prompt setup if no token is configured yet.
  if (!getConfig().bearerToken) {
    void vscode.window.showInformationMessage(
      'Graphnosis is installed. Configure the bearer token to connect it to Copilot.',
      'Configure',
    ).then((action) => {
      if (action === 'Configure') {
        void vscode.commands.executeCommand('graphnosis.configure');
      }
    });
  }
}

export function deactivate(): void {
  client = null;
}
