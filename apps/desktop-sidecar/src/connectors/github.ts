import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * GitHub connector — issues, pull requests, release notes, commits,
 * PR review comments, and CI failure summaries.
 *
 * Best paired with a `codebase` or `project` graph template. Lets you ask
 * Graphnosis things like "what's the status of issue #42?", "what changed
 * in the last release?", or "why does this file look this way?" using
 * `recall` from any AI client — including GitHub Copilot Chat via the
 * VS Code extension.
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
 *   includeIssues: boolean          — ingest open issues (default true)
 *   includePRs: boolean             — ingest open pull requests (default true)
 *   includeReleases: boolean        — ingest release notes (default true)
 *   includeCommits: boolean         — ingest recent commit messages + touched files (default true)
 *   maxCommits: number              — cap on commits ingested per pull (default 100)
 *   includeReviewComments: boolean  — ingest PR inline review threads (default false; noisy on large repos)
 *   reviewCommentsMaxPerPR: number  — max review comments per PR (default 20)
 *   includeCiFailures: boolean      — ingest recent CI workflow failure summaries (default false)
 *   ciFailuresMaxRuns: number       — max failing runs to ingest (default 20)
 *   maxPerType: number              — cap per legacy content type per pull (default 50)
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
    const includeCommits = this.config.options['includeCommits'] !== false;
    const includeReviewComments = this.config.options['includeReviewComments'] === true;
    const includeCiFailures = this.config.options['includeCiFailures'] === true;

    if (includeIssues) {
      events.push(...await this.fetchIssues(owner, repo, sinceIso));
    }
    if (includePRs) {
      events.push(...await this.fetchPRs(owner, repo, sinceIso));
    }
    if (includeReleases) {
      events.push(...await this.fetchReleases(owner, repo, sinceIso));
    }
    if (includeCommits) {
      events.push(...await this.fetchCommits(owner, repo, sinceIso));
    }
    if (includeReviewComments) {
      events.push(...await this.fetchReviewComments(owner, repo, sinceIso));
    }
    if (includeCiFailures) {
      events.push(...await this.fetchCiFailures(owner, repo));
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

  private async fetchCommits(owner: string, repo: string, sinceIso?: string): Promise<ConnectorEvent[]> {
    const max = typeof this.config.options['maxCommits'] === 'number'
      ? Math.min(Math.floor(this.config.options['maxCommits'] as number), 100)
      : 100;
    const qs = new URLSearchParams({ per_page: String(max) });
    if (sinceIso) qs.set('since', sinceIso);
    const res = await this.ghFetch(`/repos/${owner}/${repo}/commits?${qs}`);
    if (!res.ok) throw new Error(`GitHub commits fetch failed: ${res.status}`);
    const items = await res.json() as GhCommit[];
    return items.map(c => ({
      text: formatCommit(c, owner, repo),
      sourceRef: `github:${owner}/${repo}:commit:${c.sha}`,
      label: `Commit ${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]}`,
    }));
  }

  private async fetchReviewComments(owner: string, repo: string, sinceIso?: string): Promise<ConnectorEvent[]> {
    const maxPerPR = typeof this.config.options['reviewCommentsMaxPerPR'] === 'number'
      ? Math.floor(this.config.options['reviewCommentsMaxPerPR'] as number)
      : 20;
    // Fetch recent PRs to find comments on.
    const prQs = new URLSearchParams({ state: 'all', per_page: String(this.maxPerType), sort: 'updated' });
    const prRes = await this.ghFetch(`/repos/${owner}/${repo}/pulls?${prQs}`);
    if (!prRes.ok) throw new Error(`GitHub PRs fetch (for review comments) failed: ${prRes.status}`);
    const prs = await prRes.json() as GhPR[];

    const cutoff = sinceIso ? new Date(sinceIso).getTime() : 0;
    const recentPrs = prs.filter(pr => new Date(pr.updated_at).getTime() >= cutoff);

    const events: ConnectorEvent[] = [];
    for (const pr of recentPrs) {
      const qs = new URLSearchParams({ per_page: String(maxPerPR) });
      const res = await this.ghFetch(`/repos/${owner}/${repo}/pulls/${pr.number}/comments?${qs}`);
      if (!res.ok) continue;
      const comments = await res.json() as GhReviewComment[];
      for (const c of comments) {
        if (sinceIso && new Date(c.updated_at).getTime() < cutoff) continue;
        events.push({
          text: formatReviewComment(c, pr, owner, repo),
          sourceRef: `github:${owner}/${repo}:review-comment:${c.id}`,
          label: `Review on PR #${pr.number}: ${c.path}`,
        });
      }
    }
    return events;
  }

  private async fetchCiFailures(owner: string, repo: string): Promise<ConnectorEvent[]> {
    const maxRuns = typeof this.config.options['ciFailuresMaxRuns'] === 'number'
      ? Math.floor(this.config.options['ciFailuresMaxRuns'] as number)
      : 20;
    const qs = new URLSearchParams({ status: 'failure', per_page: String(maxRuns) });
    const res = await this.ghFetch(`/repos/${owner}/${repo}/actions/runs?${qs}`);
    if (!res.ok) throw new Error(`GitHub CI runs fetch failed: ${res.status}`);
    const data = await res.json() as { workflow_runs?: GhWorkflowRun[] };
    const runs = data.workflow_runs ?? [];
    return runs.map(r => ({
      text: formatCiFailure(r, owner, repo),
      sourceRef: `github:${owner}/${repo}:ci-run:${r.id}`,
      label: `CI failure: ${r.name} #${r.run_number}`,
    }));
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface GhCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  author: { login: string } | null;
  files?: Array<{ filename: string; additions: number; deletions: number }>;
}

interface GhReviewComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

interface GhWorkflowRun {
  id: number;
  name: string;
  run_number: number;
  conclusion: string | null;
  head_branch: string;
  html_url: string;
  created_at: string;
  jobs_url?: string;
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

function formatCommit(c: GhCommit, owner: string, repo: string): string {
  const subject = c.commit.message.split('\n')[0] ?? '';
  const body = c.commit.message.split('\n').slice(2).join('\n').trim();
  const author = c.author?.login ?? c.commit.author.name;
  const fileCount = c.files?.length ?? 0;
  const fileList = c.files?.map(f => f.filename).slice(0, 10).join(', ') ?? '';
  const filesSuffix = fileCount > 10 ? ` (and ${fileCount - 10} more)` : '';
  const lines = [
    `# Commit ${c.sha.slice(0, 7)}: ${subject}`,
    `Author: ${author} · Date: ${c.commit.author.date} · Repo: ${owner}/${repo}`,
    fileList && `Files changed: ${fileList}${filesSuffix}`,
    body && '',
    body && body,
  ];
  return lines.filter(Boolean).join('\n');
}

function formatReviewComment(c: GhReviewComment, pr: GhPR, owner: string, repo: string): string {
  return [
    `# Review on PR #${pr.number}: ${pr.title}`,
    `File: ${c.path}${c.line != null ? ` · Line: ${c.line}` : ''} · Author: ${c.user.login} · Date: ${c.created_at}`,
    `Repo: ${owner}/${repo}`,
    '',
    c.body,
  ].filter(Boolean).join('\n');
}

function formatCiFailure(r: GhWorkflowRun, owner: string, repo: string): string {
  return [
    `# CI Failure: ${r.name} — run #${r.run_number}`,
    `Repo: ${owner}/${repo} · Branch: ${r.head_branch} · Date: ${r.created_at}`,
    `Conclusion: ${r.conclusion ?? 'unknown'} · URL: ${r.html_url}`,
  ].filter(Boolean).join('\n');
}
