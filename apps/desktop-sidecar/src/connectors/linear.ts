import type { ConnectorConfig } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent } from './interface.js';

/**
 * Linear connector — issues, projects, and cycles from your workspace.
 *
 * Uses Linear's GraphQL API with a personal API key. No OAuth required —
 * the user creates a key at https://linear.app/settings/api and pastes it
 * into credentials.apiKey.
 *
 * Required credentials:
 *   apiKey: string   — Linear personal API key (lin_api_…)
 *
 * Optional options:
 *   teamId: string          — sync issues from a specific team only
 *   includeCompleted: boolean — include completed/cancelled issues (default false)
 *   maxIssues: number       — cap per pull (default 100)
 */
export class LinearConnector implements Connector {
  constructor(readonly config: ConnectorConfig) {}

  private get apiKey(): string {
    const k = this.config.credentials['apiKey'];
    if (!k) throw new Error('linear connector requires credentials.apiKey');
    return k;
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'GraphnosisApp/1.0',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear API request failed: ${res.status}`);
    const data = await res.json() as { data: T; errors?: Array<{ message: string }> };
    if (data.errors?.length) throw new Error(`Linear GraphQL error: ${data.errors[0]?.message ?? 'unknown error'}`);
    return data.data;
  }

  async pull(since?: Date): Promise<ConnectorEvent[]> {
    const maxIssues = typeof this.config.options['maxIssues'] === 'number'
      ? this.config.options['maxIssues'] : 100;
    const includeCompleted = this.config.options['includeCompleted'] === true;
    const teamId = typeof this.config.options['teamId'] === 'string'
      ? this.config.options['teamId'] : undefined;

    const filter: Record<string, unknown> = {};
    if (since) filter['updatedAt'] = { gt: since.toISOString() };
    if (!includeCompleted) filter['state'] = { type: { nin: ['completed', 'cancelled'] } };
    if (teamId) filter['team'] = { id: { eq: teamId } };

    const data = await this.gql<LinearIssueResult>(ISSUES_QUERY, {
      first: maxIssues,
      filter,
    });

    return data.issues.nodes.map(issue => ({
      text: formatLinearIssue(issue),
      sourceRef: `linear:${this.config.id}:issue:${issue.id}`,
      label: `${issue.identifier} ${issue.title}`,
    }));
  }
}

// ── GraphQL query ─────────────────────────────────────────────────────────────

const ISSUES_QUERY = `
  query GNIssues($first: Int, $filter: IssueFilter) {
    issues(first: $first, filter: $filter, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        description
        state { name type }
        priority
        assignee { name }
        team { name }
        labels { nodes { name } }
        url
        updatedAt
        dueDate
      }
    }
  }
`;

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  priority: number;
  assignee: { name: string } | null;
  team: { name: string };
  labels: { nodes: Array<{ name: string }> };
  url: string;
  updatedAt: string;
  dueDate: string | null;
}

interface LinearIssueResult {
  issues: { nodes: LinearIssue[] };
}

const PRIORITY_LABELS: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

function formatLinearIssue(i: LinearIssue): string {
  const labels = i.labels.nodes.map(l => l.name).join(', ');
  return [
    `# ${i.identifier}: ${i.title}`,
    `Team: ${i.team.name} · State: ${i.state.name} · Priority: ${PRIORITY_LABELS[i.priority] ?? i.priority}`,
    i.assignee && `Assignee: ${i.assignee.name}`,
    labels && `Labels: ${labels}`,
    i.dueDate && `Due: ${i.dueDate}`,
    `URL: ${i.url}`,
    '',
    i.description ?? '(no description)',
  ].filter(Boolean).join('\n');
}
