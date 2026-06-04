import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * GitHub connector — issues, pull requests, and release notes.
 *
 * Best paired with a `codebase` or `project` graph template. Lets you ask
 * Graphnosis things like "what's the status of issue #42?" or "what changed
 * in the last release?" using `recall` from any AI client.
 *
 * Required credentials:
 *   token: string   — GitHub personal access token (classic) with `repo` scope,
 *                     or a fine-grained token with Issues/PRs read access.
 *
 * Required options:
 *   owner: string   — repo owner (org name or username)
 *   repo: string    — repository name
 *
 * Optional options:
 *   includeIssues: boolean    — ingest open issues (default true)
 *   includePRs: boolean       — ingest open pull requests (default true)
 *   includeReleases: boolean  — ingest release notes (default true)
 *   maxPerType: number        — cap per content type per pull (default 50)
 */
export class GitHubConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get token(): string {
    const t = this.config.credentials['token'];
    if (!t) throw new Error('github connector requires credentials.token (personal access token)');
    return t;
  }

  private get owner(): string {
    const o = this.config.options['owner'];
    if (typeof o !== 'string' || !o) throw new Error('github connector requires options.owner');
    return o;
  }

  private get repo(): string {
    const r = this.config.options['repo'];
    if (typeof r !== 'string' || !r) throw new Error('github connector requires options.repo');
    return r;
  }

  private get maxPerType(): number {
    const n = this.config.options['maxPerType'];
    return typeof n === 'number' && n > 0 ? Math.floor(n) : 50;
  }

  private ghFetch(path: string): Promise<Response> {
    return fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GraphnosisApp/1.0',
      },
    });
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const events: ConnectorEvent[] = [];
    const sinceIso = since?.toISOString();
    const { owner, repo } = this;

    const includeIssues = this.config.options['includeIssues'] !== false;
    const includePRs = this.config.options['includePRs'] !== false;
    const includeReleases = this.config.options['includeReleases'] !== false;

    if (includeIssues) {
      events.push(...await this.fetchIssues(owner, repo, sinceIso));
    }
    if (includePRs) {
      events.push(...await this.fetchPRs(owner, repo, sinceIso));
    }
    if (includeReleases) {
      events.push(...await this.fetchReleases(owner, repo, sinceIso));
    }

    return events;
  }

  private async fetchIssues(owner: string, repo: string, sinceIso?: string): Promise<ConnectorEvent[]> {
    const qs = new URLSearchParams({ state: 'all', per_page: String(this.maxPerType), sort: 'updated' });
    if (sinceIso) qs.set('since', sinceIso);
    const res = await this.ghFetch(`/repos/${owner}/${repo}/issues?${qs}`);
    if (!res.ok) throw new Error(`GitHub issues fetch failed: ${res.status}`);
    const items = await res.json() as GhIssue[];
    return items
      .filter(i => !i.pull_request)  // issues endpoint returns PRs too
      .map(i => ({
        text: formatIssue(i, owner, repo),
        sourceRef: `github:${owner}/${repo}:issue:${i.number}`,
        label: `#${i.number} ${i.title}`,
      }));
  }

  private async fetchPRs(owner: string, repo: string, sinceIso?: string): Promise<ConnectorEvent[]> {
    const qs = new URLSearchParams({ state: 'all', per_page: String(this.maxPerType), sort: 'updated' });
    const res = await this.ghFetch(`/repos/${owner}/${repo}/pulls?${qs}`);
    if (!res.ok) throw new Error(`GitHub PRs fetch failed: ${res.status}`);
    const items = await res.json() as GhPR[];
    const cutoff = sinceIso ? new Date(sinceIso).getTime() : 0;
    return items
      .filter(pr => new Date(pr.updated_at).getTime() >= cutoff)
      .map(pr => ({
        text: formatPR(pr, owner, repo),
        sourceRef: `github:${owner}/${repo}:pr:${pr.number}`,
        label: `PR #${pr.number} ${pr.title}`,
      }));
  }

  private async fetchReleases(owner: string, repo: string, sinceIso?: string): Promise<ConnectorEvent[]> {
    const qs = new URLSearchParams({ per_page: String(this.maxPerType) });
    const res = await this.ghFetch(`/repos/${owner}/${repo}/releases?${qs}`);
    if (!res.ok) throw new Error(`GitHub releases fetch failed: ${res.status}`);
    const items = await res.json() as GhRelease[];
    const cutoff = sinceIso ? new Date(sinceIso).getTime() : 0;
    return items
      .filter(r => new Date(r.published_at).getTime() >= cutoff)
      .map(r => ({
        text: formatRelease(r, owner, repo),
        sourceRef: `github:${owner}/${repo}:release:${r.tag_name}`,
        label: `Release ${r.tag_name}`,
      }));
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  pull_request?: unknown;
}

interface GhPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  user: { login: string };
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
}

function formatIssue(i: GhIssue, owner: string, repo: string): string {
  const labels = i.labels.map(l => l.name).join(', ');
  const assignees = i.assignees.map(a => a.login).join(', ');
  return [
    `# Issue #${i.number}: ${i.title}`,
    `Repo: ${owner}/${repo} · State: ${i.state}`,
    labels && `Labels: ${labels}`,
    assignees && `Assignees: ${assignees}`,
    `URL: ${i.html_url}`,
    '',
    i.body ?? '(no description)',
  ].filter(Boolean).join('\n');
}

function formatPR(pr: GhPR, owner: string, repo: string): string {
  const labels = pr.labels.map(l => l.name).join(', ');
  return [
    `# PR #${pr.number}: ${pr.title}`,
    `Repo: ${owner}/${repo} · State: ${pr.state} · Author: ${pr.user.login}`,
    labels && `Labels: ${labels}`,
    `URL: ${pr.html_url}`,
    '',
    pr.body ?? '(no description)',
  ].filter(Boolean).join('\n');
}

function formatRelease(r: GhRelease, owner: string, repo: string): string {
  return [
    `# Release ${r.tag_name}${r.name && r.name !== r.tag_name ? ` — ${r.name}` : ''}`,
    `Repo: ${owner}/${repo} · Published: ${r.published_at}`,
    `URL: ${r.html_url}`,
    '',
    r.body ?? '(no release notes)',
  ].filter(Boolean).join('\n');
}
