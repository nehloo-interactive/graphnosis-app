import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * Trello connector — cards, checklists, and comments from selected boards.
 *
 * Trello's modern auth model uses an API Key + user Token (the "Power-Up"
 * OAuth flow is overkill for personal use). The user:
 *   1. Gets their API key from https://trello.com/power-ups/admin
 *   2. Visits the token URL this connector generates (getAuthUrl), approves,
 *      and pastes the resulting token back into Graphnosis Settings.
 *
 * No server-side redirect is required — Trello shows the token directly on
 * the approval page, so the user just copies it.
 *
 * Required credentials:
 *   apiKey: string    — Trello Power-Up API key
 *   token: string     — user-level token (from getAuthUrl approval)
 *
 * Optional options:
 *   boardIds: string[]   — Trello board IDs to sync (default: all accessible boards)
 *   maxCards: number     — cap on cards per board per pull (default 200)
 */
export class TrelloConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get apiKey(): string {
    const k = this.config.credentials['apiKey'];
    if (!k) throw new Error('trello connector requires credentials.apiKey');
    return k;
  }

  private get token(): string {
    const t = this.config.credentials['token'];
    if (!t) throw new Error('trello connector requires credentials.token. Visit the URL from connectors.getAuthUrl to obtain one.');
    return t;
  }

  getAuthUrl(_callbackUrl: string): string {
    // Trello returns the token directly on the page — no redirect needed.
    const params = new URLSearchParams({
      expiration: 'never',
      name: 'Graphnosis',
      scope: 'read',
      response_type: 'token',
      key: this.apiKey,
    });
    return `https://trello.com/1/authorize?${params}`;
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const boardIds = await this.resolveBoardIds();
    const maxCards = typeof this.config.options['maxCards'] === 'number'
      ? this.config.options['maxCards'] : 200;
    const events: ConnectorEvent[] = [];

    for (const boardId of boardIds) {
      events.push(...await this.pullBoard(boardId, maxCards, since));
    }

    return events;
  }

  private async trelloGet(path: string): Promise<unknown> {
    const url = new URL(`https://api.trello.com/1${path}`);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('token', this.token);
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'GraphnosisApp/1.0' },
    });
    if (!res.ok) throw new Error(`Trello API ${path} failed: ${res.status}`);
    return res.json();
  }

  private async resolveBoardIds(): Promise<string[]> {
    const configured = this.config.options['boardIds'];
    if (Array.isArray(configured) && configured.length > 0) {
      return configured as string[];
    }
    const boards = await this.trelloGet('/members/me/boards?fields=id,name&filter=open') as Array<{ id: string }>;
    return boards.map(b => b.id);
  }

  private async pullBoard(boardId: string, maxCards: number, since?: Date): Promise<ConnectorEvent[]> {
    const cards = await this.trelloGet(
      `/boards/${boardId}/cards?fields=id,name,desc,url,dateLastActivity,labels,idChecklists&limit=${maxCards}`,
    ) as TrelloCard[];

    const cutoff = since?.getTime() ?? 0;
    const fresh = cards.filter(c => new Date(c.dateLastActivity).getTime() >= cutoff);

    const events: ConnectorEvent[] = [];
    for (const card of fresh) {
      let body = card.desc || '';
      if (card.idChecklists && card.idChecklists.length > 0) {
        const checklistText = await this.fetchChecklists(card.idChecklists);
        if (checklistText) body += `\n\n${checklistText}`;
      }
      const labels = card.labels?.map(l => l.name).filter(Boolean).join(', ');
      events.push({
        text: [
          `# Trello card: ${card.name}`,
          labels && `Labels: ${labels}`,
          `URL: ${card.url}`,
          '',
          body || '(no description)',
        ].filter(Boolean).join('\n'),
        sourceRef: `trello:${this.config.id}:card:${card.id}`,
        label: card.name,
      });
    }

    return events;
  }

  private async fetchChecklists(ids: string[]): Promise<string> {
    const lines: string[] = [];
    for (const id of ids) {
      const cl = await this.trelloGet(`/checklists/${id}?fields=name&checkItems=all&checkItem_fields=name,state`) as TrelloChecklist;
      lines.push(`## ${cl.name}`);
      for (const item of cl.checkItems ?? []) {
        lines.push(`- [${item.state === 'complete' ? 'x' : ' '}] ${item.name}`);
      }
    }
    return lines.join('\n');
  }
}

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  dateLastActivity: string;
  labels?: Array<{ name: string }>;
  idChecklists?: string[];
}

interface TrelloChecklist {
  name: string;
  checkItems: Array<{ name: string; state: 'complete' | 'incomplete' }>;
}
