import { JSDOM } from 'jsdom';
import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * RSS / Atom feed connector.
 *
 * Fetches the configured feed URL and ingests new items published after the
 * last pull. Works with any standards-compliant RSS 2.0 or Atom 1.0 feed —
 * newsletters, research blogs, release notes, etc.
 *
 * Required options:
 *   feedUrl: string   — the URL of the feed to fetch
 *
 * Optional options:
 *   maxItems: number  — cap on items per pull (default 20)
 *   title: string     — friendly label prefix for ingested items
 */
export class RssConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get feedUrl(): string {
    const url = this.config.options['feedUrl'];
    if (typeof url !== 'string' || !url) throw new Error('rss connector requires options.feedUrl');
    return url;
  }

  private get maxItems(): number {
    const n = this.config.options['maxItems'];
    return typeof n === 'number' && n > 0 ? Math.floor(n) : 20;
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const res = await fetch(this.feedUrl, {
      headers: { 'User-Agent': 'GraphnosisApp/1.0 RSS reader (+local)' },
    });
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
    const xml = await res.text();
    const items = parseXmlFeed(xml, this.feedUrl);

    const sinceTime = since?.getTime() ?? 0;
    const fresh = items
      .filter(item => item.pubDate > sinceTime)
      .slice(0, this.maxItems);

    return fresh.map(item => ({
      text: `# ${item.title}\n\n${item.description}\n\nSource: ${item.link}`,
      sourceRef: `rss:${this.config.id}:${item.guid || item.link}`,
      label: item.title || this.feedUrl,
    }));
  }
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  guid: string;
  pubDate: number;
}

function parseXmlFeed(xml: string, feedUrl: string): FeedItem[] {
  // Use jsdom (already a project dependency) to parse the XML without adding
  // a new RSS-parser dependency. JSDOM's querySelector works on XML docs.
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  // ── RSS 2.0 ──────────────────────────────────────────────────────────────
  const rssItems = doc.querySelectorAll('item');
  if (rssItems.length > 0) {
    return Array.from(rssItems).map((el): FeedItem => {
      const text = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? '';
      const link = text('link') || text('guid') || feedUrl;
      const pubDateStr = text('pubDate');
      return {
        title: text('title'),
        link,
        description: text('description'),
        guid: text('guid') || link,
        pubDate: pubDateStr ? Date.parse(pubDateStr) : 0,
      };
    });
  }

  // ── Atom 1.0 ─────────────────────────────────────────────────────────────
  const atomEntries = doc.querySelectorAll('entry');
  return Array.from(atomEntries).map((el): FeedItem => {
    const text = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? '';
    const linkEl = el.querySelector('link[href]');
    const link = linkEl?.getAttribute('href') ?? feedUrl;
    const pubDateStr = text('published') || text('updated');
    return {
      title: text('title'),
      link,
      description: text('summary') || text('content'),
      guid: text('id') || link,
      pubDate: pubDateStr ? Date.parse(pubDateStr) : 0,
    };
  });
}
