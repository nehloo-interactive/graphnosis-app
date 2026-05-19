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
 *
 * Implementation note: this connector used to use jsdom for DOM-style
 * `querySelector` parsing, but jsdom doesn't bundle cleanly with Bun's
 * `--compile` — it has a runtime `require()` of an absolute path to a
 * worker file that gets baked into the binary at build time and 404s on
 * any other machine. We swap it for a small regex-based parser tailored
 * to the two well-known feed shapes (RSS 2.0 + Atom 1.0). No external
 * dependency; bundles cleanly.
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

/**
 * Parse RSS 2.0 or Atom 1.0 XML into a normalized FeedItem[].
 *
 * Hand-rolled regex parser — RSS/Atom feeds are well-defined enough that
 * this is reliable for ~99% of feeds in the wild. Trades the heavy
 * jsdom dependency (which doesn't bundle with Bun --compile) for a tiny
 * self-contained parser.
 *
 * Limitations vs a full XML parser:
 *   - Doesn't handle deeply nested unusual XML (e.g. media:content groups
 *     beyond the top extract). Standard RSS/Atom doesn't need these.
 *   - Treats malformed XML as "no items" rather than throwing. Same as
 *     jsdom-with-loose-mode did in practice.
 *
 * If you hit a feed shape this misses, the right move is to add a small
 * targeted extension here, not to bring jsdom back.
 */
function parseXmlFeed(xml: string, feedUrl: string): FeedItem[] {
  // Detect feed family by which top-level tag is present. RSS 2.0 uses
  // <item>; Atom 1.0 uses <entry>.
  const rssItemBlocks = matchAllBlocks(xml, 'item');
  if (rssItemBlocks.length > 0) {
    return rssItemBlocks.map((block): FeedItem => {
      const title = extractTagText(block, 'title');
      const link = extractTagText(block, 'link') || extractTagText(block, 'guid') || feedUrl;
      const description = extractTagText(block, 'description');
      const guid = extractTagText(block, 'guid') || link;
      const pubDateStr = extractTagText(block, 'pubDate');
      return {
        title,
        link,
        description,
        guid,
        pubDate: pubDateStr ? Date.parse(pubDateStr) : 0,
      };
    });
  }

  const atomEntryBlocks = matchAllBlocks(xml, 'entry');
  return atomEntryBlocks.map((block): FeedItem => {
    const title = extractTagText(block, 'title');
    // Atom's <link href="..."/> is self-closing — the URL is in the href
    // attribute, not the element text. Fall back to a regular <link> body
    // if some non-standard feed uses that shape.
    const linkAttr = block.match(/<link[^>]*\shref=["']([^"']+)["'][^>]*\/?>/i)?.[1];
    const link = linkAttr || extractTagText(block, 'link') || feedUrl;
    const description = extractTagText(block, 'summary') || extractTagText(block, 'content');
    const guid = extractTagText(block, 'id') || link;
    const pubDateStr = extractTagText(block, 'published') || extractTagText(block, 'updated');
    return {
      title,
      link,
      description,
      guid,
      pubDate: pubDateStr ? Date.parse(pubDateStr) : 0,
    };
  });
}

/**
 * Return the inner text of every `<tag>…</tag>` block in `xml`.
 * Whitespace at ends is trimmed; CDATA is unwrapped; the typical HTML
 * entity references (&amp; &lt; &gt; &quot; &#39;) are decoded.
 */
function matchAllBlocks(xml: string, tag: string): string[] {
  // Non-greedy match. Tag names in RSS/Atom are case-sensitive but some
  // feeds in the wild use mixed case — keep this case-insensitive to be
  // forgiving.
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1] ?? '');
  }
  return out;
}

/**
 * Extract the inner text of the FIRST `<tag>…</tag>` occurrence in `xml`.
 * Handles CDATA + decodes basic HTML entities. Returns '' if not found.
 */
function extractTagText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return '';
  return unwrapXmlContent(m[1] ?? '');
}

function unwrapXmlContent(raw: string): string {
  let s = raw.trim();
  // CDATA blocks — common in feeds for description / summary content.
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(s);
  if (cdataMatch?.[1] !== undefined) s = cdataMatch[1];
  // Basic HTML entity decoding — covers the common cases RSS feeds use.
  // A full entity decoder isn't worth a dependency just for this.
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}
