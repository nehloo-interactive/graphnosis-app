import * as vscode from 'vscode';
import type { GraphnosisClient } from './graphnosis-client';
import { getConfig } from './config';

export function registerParticipant(
  context: vscode.ExtensionContext,
  getClient: () => GraphnosisClient | null,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'graphnosis.assistant',
    async (request, _ctx, response, _token) => {
      const client = getClient();
      if (!client) {
        response.markdown(
          'Graphnosis is not connected. Run **Graphnosis: Configure connection** ' +
          '(⌘⇧P → "Graphnosis: Configure") to paste your bearer token.',
        );
        return;
      }

      response.progress('Searching your Cortex…');

      let memory: string;
      try {
        const cfg = getConfig();
        memory = await client.recall(request.prompt, cfg.maxTokensPerInjection);
      } catch (e) {
        response.markdown(`Could not reach Graphnosis: ${(e as Error).message}`);
        return;
      }

      if (!memory || memory === '(no results)') {
        response.markdown('No relevant memories found for this query.');
        return;
      }

      response.markdown('**From your Graphnosis Cortex:**\n\n' + memory);
    },
  );

  participant.iconPath = new vscode.ThemeIcon('database');
  context.subscriptions.push(participant);
  return participant;
}
