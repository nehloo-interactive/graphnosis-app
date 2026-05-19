import * as vscode from 'vscode';
import type { GraphnosisClient } from './graphnosis-client';
import { getConfig } from './config';

/**
 * Register graphnosis_recall and graphnosis_remember as VS Code Language Model
 * tools (VS Code 1.97+). When registered, Copilot can autonomously call recall
 * on context-sensitive queries without the user typing @graphnosis. The tool
 * descriptions are the primary nudge — same strategy as SERVER_INSTRUCTIONS in
 * the sidecar's mcp-server.ts, but operating at the VS Code tool layer.
 *
 * Returns an empty array on VS Code < 1.97 (API not available), so the caller
 * can push the result into context.subscriptions unconditionally.
 */
export function registerLmTools(
  getClient: () => GraphnosisClient | null,
): vscode.Disposable[] {
  const lm = vscode.lm as typeof vscode.lm & {
    registerTool?: <T>(name: string, tool: unknown) => vscode.Disposable;
  };
  if (typeof lm?.registerTool !== 'function') return [];

  const cfg = getConfig();
  if (!cfg.autoInject) return [];

  const recallTool = lm.registerTool<{ query: string; maxTokens?: number }>(
    'graphnosis_recall',
    {
      description:
        "Search the user's private Graphnosis memory graph for relevant context. " +
        "Call this before answering questions about the user's projects, preferences, " +
        'past architectural decisions, code conventions, or history. ' +
        'Results come from a local encrypted store — nothing leaves the device.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language description of the context needed',
          },
          maxTokens: {
            type: 'number',
            description: 'Token budget for the response (default 1500, max 8000)',
          },
        },
        required: ['query'],
      },
      invoke: async (options: { input: { query: string; maxTokens?: number } }, _token: vscode.CancellationToken) => {
        const client = getClient();
        if (!client) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(''),
          ]);
        }
        const maxTokens = options.input.maxTokens ?? getConfig().maxTokensPerInjection;
        try {
          const result = await client.recall(options.input.query, maxTokens);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result),
          ]);
        } catch {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(''),
          ]);
        }
      },
    },
  );

  const rememberTool = lm.registerTool<{ text: string; label?: string }>(
    'graphnosis_remember',
    {
      description:
        "Save a note to the user's private Graphnosis memory graph. " +
        'Call this when the user explicitly asks to save something, or when you have ' +
        'helped the user reach an architectural decision, naming convention, or technical ' +
        'choice they would clearly want to remember across sessions. ' +
        'Ask the user before calling if unsure.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'The text content to save as a memory',
          },
          label: {
            type: 'string',
            description: 'Optional short label for this memory (e.g. "auth flow decision")',
          },
        },
        required: ['text'],
      },
      invoke: async (options: { input: { text: string; label?: string } }, _token: vscode.CancellationToken) => {
        const client = getClient();
        if (!client) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Not connected to Graphnosis.'),
          ]);
        }
        try {
          await client.remember(options.input.text, options.input.label);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Saved to Graphnosis memory.'),
          ]);
        } catch (e) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Failed to save: ${(e as Error).message}`),
          ]);
        }
      },
    },
  );

  return [recallTool, rememberTool];
}
