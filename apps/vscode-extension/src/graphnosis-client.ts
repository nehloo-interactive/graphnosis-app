/** Thin HTTP client for the Graphnosis local MCP bridge (mcp-http-server.ts). */
export class GraphnosisClient {
  private sessionId: string | undefined;
  private requestId = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async recall(query: string, maxTokens: number): Promise<string> {
    const result = await this.callTool('recall', { query, maxTokens }) as {
      content?: Array<{ type: string; text?: string }>;
    } | undefined;
    if (result?.content && Array.isArray(result.content)) {
      return result.content.map(c => c.text ?? '').filter(Boolean).join('\n');
    }
    return '(no results)';
  }

  async remember(text: string, label?: string): Promise<void> {
    await this.callTool('remember', {
      text,
      kind: 'ai-conversation',
      ...(label ? { label } : {}),
    });
  }

  /** Returns true if the bridge is reachable with the current token. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextId(),
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'vscode-graphnosis', version: '0.1.0' },
          },
        }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Graphnosis bridge returned HTTP ${res.status}`);
    }

    if (!this.sessionId) {
      const sid = res.headers.get('Mcp-Session-Id');
      if (sid) this.sessionId = sid;
    }

    const json = await res.json() as {
      result?: unknown;
      error?: { message?: string; code?: number };
    };

    if (json.error) {
      throw new Error(`Graphnosis MCP error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    return json.result;
  }
}
