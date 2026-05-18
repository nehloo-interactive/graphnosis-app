import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * Slack connector — starred items, saved messages, and selected channels.
 *
 * Uses Slack Web API v2 OAuth. The user (or Nelu) registers a Slack App and
 * provides the client credentials; the connector drives the OAuth flow via
 * the manager's callback server and stores the resulting access token.
 *
 * Required credentials (after OAuth):
 *   accessToken: string   — Slack user OAuth token (xoxp-…)
 *
 * Credentials for OAuth setup:
 *   clientId: string
 *   clientSecret: string
 *
 * Optional options:
 *   channels: string[]        — channel IDs to pull history from ([] = none)
 *   includeStarred: boolean   — pull Slack starred items (default true)
 *   maxMessages: number       — cap on messages per channel per pull (default 100)
 *
 * Required Slack OAuth scopes:
 *   stars:read, channels:history, groups:history, im:history, mpim:history
 *   (channel scopes are only needed if channels list is non-empty)
 */
export class SlackConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get token(): string {
    const t = this.config.credentials['accessToken'];
    if (!t) throw new Error('slack connector needs credentials.accessToken. Run OAuth flow first via connectors.getAuthUrl.');
    return t;
  }

  private get clientId(): string {
    return this.config.credentials['clientId'] ?? '';
  }

  private get clientSecret(): string {
    return this.config.credentials['clientSecret'] ?? '';
  }

  getAuthUrl(callbackUrl: string): string {
    if (!this.clientId) throw new Error('slack connector requires credentials.clientId for OAuth');
    const scopes = [
      'stars:read',
      'channels:history', 'groups:history', 'im:history', 'mpim:history',
      'channels:read', 'users:read',
    ].join(',');
    const params = new URLSearchParams({
      client_id: this.clientId,
      scope: scopes,
      redirect_uri: callbackUrl,
      state: this.config.id,
    });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  }

  async handleOAuthCallback(code: string, _state: string): Promise<Record<string, string>> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('slack connector requires credentials.clientId + clientSecret for OAuth');
    }
    const params = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json() as { ok: boolean; authed_user?: { access_token?: string }; error?: string };
    if (!data.ok) throw new Error(`Slack OAuth failed: ${data.error}`);
    const accessToken = data.authed_user?.access_token ?? '';
    if (!accessToken) throw new Error('Slack OAuth response missing authed_user.access_token');
    return { ...this.config.credentials, accessToken };
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const events: ConnectorEvent[] = [];
    const includeStarred = this.config.options['includeStarred'] !== false;

    if (includeStarred) {
      events.push(...await this.pullStarred(since));
    }

    const channels = this.config.options['channels'];
    if (Array.isArray(channels) && channels.length > 0) {
      for (const channelId of channels as string[]) {
        events.push(...await this.pullChannel(channelId, since));
      }
    }

    return events;
  }

  private async slackGet(method: string, params: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(params);
    const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Slack API ${method} failed: ${res.status}`);
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`Slack API ${method} error: ${data.error}`);
    return data;
  }

  private async pullStarred(since?: Date): Promise<ConnectorEvent[]> {
    const data = await this.slackGet('stars.list', { count: '100' }) as {
      items: SlackStarredItem[];
    };
    const cutoff = since?.getTime() ?? 0;
    return data.items
      .filter(item => {
        const ts = tsToMs(item.message?.ts ?? item.file?.timestamp?.toString());
        return ts >= cutoff;
      })
      .map(item => {
        const text = item.message?.text ?? item.file?.title ?? '(starred item)';
        const ts = item.message?.ts ?? Date.now().toString();
        const channel = item.channel ?? 'unknown';
        return {
          text: `# Starred Slack message\n\n${text}\n\nChannel: <#${channel}>`,
          sourceRef: `slack:${this.config.id}:starred:${channel}:${ts}`,
          label: 'Starred Slack message',
        };
      });
  }

  private async pullChannel(channelId: string, since?: Date): Promise<ConnectorEvent[]> {
    const maxMessages = this.config.options['maxMessages'];
    const limit = typeof maxMessages === 'number' ? maxMessages : 100;
    const params: Record<string, string> = { channel: channelId, limit: String(limit) };
    if (since) params['oldest'] = String(since.getTime() / 1000);

    const data = await this.slackGet('conversations.history', params) as {
      messages: SlackMessage[];
    };

    return data.messages
      .filter(m => m.text && !m.subtype)  // skip joins, leaves, etc.
      .map(m => ({
        text: `# Slack message in <#${channelId}>\n\n${m.text}`,
        sourceRef: `slack:${this.config.id}:channel:${channelId}:${m.ts}`,
        label: `Slack #${channelId}`,
      }));
  }
}

interface SlackMessage {
  ts: string;
  text: string;
  subtype?: string;
}

interface SlackStarredItem {
  type: string;
  channel?: string;
  message?: { ts: string; text: string };
  file?: { timestamp: number; title: string };
}

function tsToMs(ts?: string): number {
  if (!ts) return 0;
  return parseFloat(ts) * 1000;
}
