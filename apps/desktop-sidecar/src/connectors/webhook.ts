import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * Generic incoming webhook connector.
 *
 * Any service that can send an HTTP POST (Zapier, Make, n8n, Slack outgoing
 * webhooks, custom scripts) can push memories directly into a Graphnosis
 * engram without OAuth.
 *
 * Payload format (JSON body):
 *   { text: string, label?: string, source?: string }
 *
 * The manager routes requests to this connector at:
 *   POST /webhook/<connectorId>/<webhookToken>
 *
 * The token is stored in options.webhookToken and shown in the Settings UI.
 * It prevents enumeration of connector IDs — even if someone guesses the
 * connectorId, they need the per-connector token to push.
 *
 * Setup: user generates a token (or we auto-generate one on install), then
 * pastes the full URL into the external service's webhook settings.
 */
export class WebhookConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  async handleWebhook(body: unknown, _headers: Record<string, string>): Promise<ConnectorEvent[]> {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Webhook body must be a JSON object');
    }
    const b = body as Record<string, unknown>;
    const text = typeof b['text'] === 'string' ? b['text'].trim() : '';
    if (!text) throw new Error('Webhook body must include a non-empty "text" field');

    const label = typeof b['label'] === 'string' ? b['label'] : 'Webhook';
    const source = typeof b['source'] === 'string' ? b['source'] : `webhook:${this.config.id}`;
    const sourceRef = `webhook:${this.config.id}:${source}:${Date.now()}`;

    return [{ text, sourceRef, label }];
  }
}
