import { randomBytes, createHash } from 'node:crypto';
import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * X (formerly Twitter) connector — your own bookmarks and your own recent
 * posts, via X API v2 with OAuth 2.0 + PKCE (user-context).
 *
 * Bring-your-own-app model, same as Slack: create an X Developer Portal app,
 * enable OAuth 2.0, register Graphnosis's callback as a redirect URI, and
 * paste the Client ID/Secret into the connector form. Graphnosis drives the
 * PKCE authorization flow via the manager's callback server and stores the
 * resulting access/refresh tokens.
 *
 * Required credentials (bring your own app):
 *   clientId: string
 *   clientSecret: string   — X issues confidential-client secrets for
 *                            "Web App, Automated App or Bot" app types.
 *
 * Required credentials (after OAuth — written by handleOAuthCallback):
 *   accessToken: string
 *   refreshToken: string
 *   expiresAt: string      — epoch ms (as a string; credentials are string-only)
 *
 * Optional options:
 *   includeBookmarks: boolean   — pull your own bookmarks (default true)
 *   includeOwnPosts: boolean    — pull your own recent posts (default true)
 *   maxPerType: number          — cap per item type per pull (default 50, X API max 100)
 *
 * X API scopes required: tweet.read, users.read, bookmark.read, offline.access
 * (offline.access is what makes X issue a refresh_token).
 *
 * v1 scope: bookmarks + own posts only. Deliberately deferred — see
 * apps/docs/src/content/docs/guides/connectors.md and the PR/task summary:
 * mentions, home/search timelines, trends, Articles, and DMs.
 */
export class XConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get clientId(): string {
    const v = this.config.credentials['clientId'];
    if (!v) throw new Error('x connector requires credentials.clientId (from your X Developer Portal app)');
    return v;
  }

  private get clientSecret(): string {
    const v = this.config.credentials['clientSecret'];
    if (!v) throw new Error('x connector requires credentials.clientSecret (from your X Developer Portal app)');
    return v;
  }

  private get accessToken(): string {
    const v = this.config.credentials['accessToken'];
    if (!v) throw new Error('x connector needs credentials.accessToken. Run OAuth flow first via connectors.getAuthUrl.');
    return v;
  }

  private get refreshTokenValue(): string | undefined {
    return this.config.credentials['refreshToken'];
  }

  private get expiresAtMs(): number {
    const v = this.config.credentials['expiresAt'];
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  // ── OAuth 2.0 + PKCE ────────────────────────────────────────────────────────

  getAuthUrl(callbackUrl: string): string {
    // PKCE: generate a code_verifier and its S256 challenge. The verifier is
    // stashed in credentials (same live object the manager holds in
    // settings.configs) so the later handleOAuthCallback — a separate
    // Connector instance built fresh by the manager — can retrieve it.
    const verifier = base64url(randomBytes(32));
    this.config.credentials['pkceVerifier'] = verifier;
    // X requires the exact redirect_uri used here to be repeated verbatim in
    // the token exchange. Stash it alongside the verifier (rather than
    // recomputing it in handleOAuthCallback) so it's correct regardless of
    // the configured webhook host/port.
    this.config.credentials['pkceCallbackUrl'] = callbackUrl;
    const challenge = base64url(createHash('sha256').update(verifier).digest());

    const scopes = ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'].join(' ');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: callbackUrl,
      scope: scopes,
      state: this.config.id,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `https://x.com/i/oauth2/authorize?${params}`;
  }

  async handleOAuthCallback(code: string, _state: string): Promise<Record<string, string>> {
    const verifier = this.config.credentials['pkceVerifier'];
    const callbackUrl = this.config.credentials['pkceCallbackUrl'];
    if (!verifier || !callbackUrl) {
      throw new Error('x connector: missing PKCE state — restart the OAuth flow via connectors.getAuthUrl');
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      code_verifier: verifier,
      client_id: this.clientId,
    });
    const res = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: params.toString(),
    });
    const data = await res.json() as XTokenResponse & { error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      throw new Error(`X OAuth token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
    }

    // Drop the one-shot PKCE state now that the exchange succeeded — it must
    // never be reused, and leaving it around would confuse a future re-auth.
    const { pkceVerifier: _v, pkceCallbackUrl: _c, ...rest } = this.config.credentials;
    return {
      ...rest,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? '',
      expiresAt: String(Date.now() + (data.expires_in ?? 7200) * 1000),
    };
  }

  /** Refresh the access token if it's missing or within 60s of expiry.
   *  Mutates `this.config.credentials` in place — the SAME object the
   *  manager holds in `settings.configs`, so the refreshed tokens ride along
   *  on the next `updateConnectorState` persist (mirrors how the manager
   *  itself persists OAuth-callback credentials). X rotates refresh tokens
   *  on every use, so the new one MUST replace the old one. */
  private async ensureFreshToken(): Promise<void> {
    const needsRefresh = !this.config.credentials['accessToken'] || Date.now() > this.expiresAtMs - 60_000;
    if (!needsRefresh) return;
    const refreshToken = this.refreshTokenValue;
    if (!refreshToken) throw new Error('x connector: access token expired and no refreshToken on file — re-run OAuth via connectors.getAuthUrl');

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    });
    const res = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: params.toString(),
    });
    const data = await res.json() as XTokenResponse & { error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      throw new Error(`X token refresh failed: ${data.error_description ?? data.error ?? res.status}`);
    }
    this.config.credentials['accessToken'] = data.access_token;
    if (data.refresh_token) this.config.credentials['refreshToken'] = data.refresh_token;
    this.config.credentials['expiresAt'] = String(Date.now() + (data.expires_in ?? 7200) * 1000);
  }

  // ── Pull ─────────────────────────────────────────────────────────────────

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    await this.ensureFreshToken();
    const events: ConnectorEvent[] = [];

    const includeBookmarks = this.config.options['includeBookmarks'] !== false;
    const includeOwnPosts = this.config.options['includeOwnPosts'] !== false;
    if (!includeBookmarks && !includeOwnPosts) return events;

    const userId = await this.fetchMyUserId();

    if (includeBookmarks) {
      events.push(...await this.fetchBookmarks(userId));
    }
    if (includeOwnPosts) {
      events.push(...await this.fetchOwnPosts(userId, since));
    }

    return events;
  }

  private async xFetch(path: string, retry = true): Promise<Response> {
    const res = await fetch(`https://api.x.com${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'User-Agent': 'GraphnosisApp/1.0',
      },
    });
    // A 401 mid-session (expired between ensureFreshToken and the call, or a
    // clock-skew edge) gets exactly one refresh-and-retry, mirroring the
    // ensureFreshToken pre-flight check above without looping forever.
    if (res.status === 401 && retry) {
      await this.ensureFreshToken();
      return this.xFetch(path, false);
    }
    return res;
  }

  private async fetchMyUserId(): Promise<string> {
    const cached = this.config.credentials['userId'];
    if (cached) return cached;
    const res = await this.xFetch('/2/users/me');
    if (!res.ok) throw new Error(`X users/me fetch failed: ${res.status}`);
    const data = await res.json() as { data?: { id: string; username: string } };
    if (!data.data?.id) throw new Error('X users/me returned no user id');
    this.config.credentials['userId'] = data.data.id;
    this.config.credentials['username'] = data.data.username ?? '';
    return data.data.id;
  }

  private get maxPerType(): number {
    const n = this.config.options['maxPerType'];
    return typeof n === 'number' && n > 0 ? Math.min(Math.floor(n), 100) : 50;
  }

  /**
   * X API v2's bookmarks endpoint (GET /2/users/:id/bookmarks) has no
   * server-side `start_time` filter — it's cursor-paginated by
   * `pagination_token` only. v1 pulls a single page (most-recent-first) each
   * pull; multi-page draining of a large bookmark backlog is deferred (see
   * docs) since the manager already dedupes by sourceRef.
   */
  private async fetchBookmarks(userId: string): Promise<ConnectorEvent[]> {
    const qs = new URLSearchParams({
      max_results: String(this.maxPerType),
      'tweet.fields': 'created_at,author_id,text',
      expansions: 'author_id',
      'user.fields': 'username,name',
    });
    const res = await this.xFetch(`/2/users/${userId}/bookmarks?${qs}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`X bookmarks fetch failed: ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    }
    const data = await res.json() as XTweetsResponse;
    const usersById = new Map((data.includes?.users ?? []).map(u => [u.id, u]));
    return (data.data ?? []).map(t => {
      const author = usersById.get(t.author_id ?? '');
      return {
        text: formatPost(t, author, 'Bookmarked'),
        sourceRef: `x:${this.config.id}:bookmark:${t.id}`,
        label: `Bookmark: ${truncate(t.text, 60)}`,
      };
    });
  }

  /** GET /2/users/:id/tweets supports `start_time`, so own posts DO get an
   *  incremental `since` filter (unlike bookmarks above). */
  private async fetchOwnPosts(userId: string, since?: Date): Promise<ConnectorEvent[]> {
    const qs = new URLSearchParams({
      max_results: String(this.maxPerType),
      exclude: 'retweets,replies',
      'tweet.fields': 'created_at,author_id,text',
      expansions: 'author_id',
      'user.fields': 'username,name',
    });
    if (since) qs.set('start_time', since.toISOString());
    const res = await this.xFetch(`/2/users/${userId}/tweets?${qs}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`X own-posts fetch failed: ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    }
    const data = await res.json() as XTweetsResponse;
    const usersById = new Map((data.includes?.users ?? []).map(u => [u.id, u]));
    return (data.data ?? []).map(t => {
      const author = usersById.get(t.author_id ?? '');
      return {
        text: formatPost(t, author, 'Posted'),
        sourceRef: `x:${this.config.id}:post:${t.id}`,
        label: `Post: ${truncate(t.text, 60)}`,
      };
    });
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface XTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
}

interface XUser {
  id: string;
  username: string;
  name?: string;
}

interface XTweetsResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count?: number; next_token?: string };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function formatPost(t: XTweet, author: XUser | undefined, verb: string): string {
  const handle = author?.username ? `@${author.username}` : 'unknown';
  return [
    `# ${verb} on X: ${truncate(t.text, 80)}`,
    `Author: ${handle}${author?.name ? ` (${author.name})` : ''}${t.created_at ? ` · ${t.created_at}` : ''}`,
    `URL: https://x.com/${author?.username ?? 'i/web'}/status/${t.id}`,
    '',
    t.text,
  ].filter(Boolean).join('\n');
}
