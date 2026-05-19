import * as vscode from 'vscode';
import type { GraphnosisClient } from './graphnosis-client';

// Minimum inserted characters to consider showing the status bar "Save?" prompt.
const SAVE_PROMPT_MIN_CHARS = 300;

// How long (ms) the status bar item stays visible before auto-hiding.
const STATUS_BAR_TTL_MS = 15_000;

let statusBar: vscode.StatusBarItem | undefined;
let pendingText: string | undefined;
let autohideTimer: ReturnType<typeof setTimeout> | undefined;

function showSavePrompt(text: string): void {
  pendingText = text;
  if (!statusBar) return;
  statusBar.text = '$(database) Save to Graphnosis?';
  statusBar.show();
  if (autohideTimer) clearTimeout(autohideTimer);
  autohideTimer = setTimeout(() => {
    statusBar?.hide();
    pendingText = undefined;
  }, STATUS_BAR_TTL_MS);
}

export function registerRememberFlow(
  context: vscode.ExtensionContext,
  getClient: () => GraphnosisClient | null,
): vscode.Disposable[] {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'graphnosis.saveResponse';
  statusBar.tooltip = 'Click to save this to your Graphnosis Cortex';

  // "Save to memory" — works on the current selection or the last Copilot insertion.
  const saveCmd = vscode.commands.registerCommand('graphnosis.saveResponse', async () => {
    const client = getClient();
    if (!client) {
      void vscode.window.showErrorMessage(
        'Graphnosis: not connected. Run "Graphnosis: Configure connection" to set the bearer token.',
      );
      return;
    }

    const editor = vscode.window.activeTextEditor;
    const selection = editor?.selection;
    const selectedText = selection && !selection.isEmpty
      ? editor.document.getText(selection)
      : undefined;

    const text = selectedText ?? pendingText;
    if (!text?.trim()) {
      void vscode.window.showInformationMessage(
        'Graphnosis: select text to save, or use this command immediately after a Copilot insertion.',
      );
      return;
    }

    const label = await vscode.window.showInputBox({
      prompt: 'Short label for this memory (optional, press Enter to skip)',
      placeHolder: 'e.g. "auth flow decision"',
    });
    // undefined = user cancelled the input box
    if (label === undefined) return;

    try {
      await client.remember(text, label.trim() || undefined);
      void vscode.window.showInformationMessage('Saved to Graphnosis memory.');
      pendingText = undefined;
      statusBar?.hide();
      if (autohideTimer) clearTimeout(autohideTimer);
    } catch (e) {
      void vscode.window.showErrorMessage(`Graphnosis: save failed — ${(e as Error).message}`);
    }
  });

  // Watch for large document insertions that look like Copilot completions.
  const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!getClient()) return;
    // Ignore change events not in the active editor (background indexing, etc.).
    if (e.document !== vscode.window.activeTextEditor?.document) return;

    const largestInsert = e.contentChanges
      .filter(c => c.text.length >= SAVE_PROMPT_MIN_CHARS)
      .reduce<string>((max, c) => c.text.length > max.length ? c.text : max, '');

    if (largestInsert) {
      showSavePrompt(largestInsert);
    }
  });

  return [saveCmd, onDocChange, statusBar];
}
