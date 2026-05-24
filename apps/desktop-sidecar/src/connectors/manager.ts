import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { GraphnosisHost } from '../host.js';
import { ingestClip } from '../ingest.js';
import { withEmbedding } from '../embedding-queue.js';
import type { ConnectorConfig, ConnectorSettings } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent, ConnectorStatus } from './interface.js';
import { WebhookConnector } from './webhook.js';
import { RssConnector } from './rss.js';
import { GitHubConnector } from './github.js';
import { SlackConnector } from './slack.js';
import { TrelloConnector } from './trello.js';
import { LinearConnector } from './linear.js';
import { ObsidianConnector } from './obsidian.js';
import { GBrainConnector } from './gbrain.js';
import { AiContextConnector } from './ai-context.js';

interface RunningConnector {
  connector: Connector;
  pullTimer: ReturnType<typeof setInterval> | null;
  eventsTotal: number;
  pulling: boolean;
}

export class ConnectorManager {
  private running = new Map<string, RunningConnector>();
  private webhookServer: http.Server | null = null;
  private settings: ConnectorSettings;

  constructor(
    private readonly host: GraphnosisHost,
    settings: ConnectorSettings,
  ) {
    this.settings = settings;
  }

  /** Boot all enabled connectors and start the webhook HTTP server if needed. */
  async start(): Promise<void> {
    for (const cfg of this.settings.configs) {
      if (cfg.enabled) {
        this.mountConnector(cfg);
      }
    }
    await this.startWebhookServerIfNeeded();
  }

  /** Clean up all timers and close the webhook server. */
  async stop(): Promise<void> {
    for (const { pullTimer } of this.running.values()) {
      if (pullTimer) clearInterval(pullTimer);
    }
    this.running.clear();
    if (this.webhookServer) {
      await new Promise<void>((resolve) => this.webhookServer!.close(() => resolve()));
      this.webhookServer = null;
    }
  }

  // ── IPC-facing methods ────────────────────────────────────────────────────

  /** List all connector configs with their current runtime statuses. */
  list(): { configs: ConnectorConfig[]; statuses: ConnectorStatus[] } {
    const configs = this.settings.configs;
    const statuses: ConnectorStatus[] = configs.map(cfg => {
      const rc = this.running.get(cfg.id);
      // Conditional spread so we never set an explicit `undefined` on
      // optional fields — required under exactOptionalPropertyTypes.
      return {
        id: cfg.id,
        kind: cfg.kind,
        enabled: cfg.enabled,
        ...(cfg.lastPulledAt !== undefined ? { lastPulledAt: cfg.lastPulledAt } : {}),
        ...(cfg.lastError !== undefined ? { lastError: cfg.lastError } : {}),
        eventsTotal: rc?.eventsTotal ?? 0,
        pulling: rc?.pulling ?? false,
      };
    });
    return { configs, statuses };
  }

  /** Install or update a connector. Auto-generates missing required options. */
  async install(partial: Partial<ConnectorConfig> & { kind: ConnectorConfig['kind'] }): Promise<ConnectorConfig> {
    const existing = this.settings.configs.find(c => c.id === partial.id);
    const id = partial.id ?? existing?.id ?? slugify(partial.kind);
    const cfg: ConnectorConfig = {
      id,
      kind: partial.kind,
      graphId: partial.graphId ?? this.host.listGraphs()[0] ?? 'personal',
      enabled: partial.enabled ?? true,
      credentials: { ...(existing?.credentials ?? {}), ...(partial.credentials ?? {}) },
      options: { ...(existing?.options ?? {}), ...(partial.options ?? {}) },
      // Conditional spread to preserve absent-vs-undefined distinction
      // required under exactOptionalPropertyTypes.
      ...(existing?.lastPulledAt !== undefined ? { lastPulledAt: existing.lastPulledAt } : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
    };

    // Webhook connectors need a per-connector token for the URL path.
    if (cfg.kind === 'webhook' && !cfg.options['webhookToken']) {
      cfg.options['webhookToken'] = randomUUID();
    }

    const newConfigs = existing
      ? this.settings.configs.map(c => c.id === id ? cfg : c)
      : [...this.settings.configs, cfg];
    await this.persistConfigs(newConfigs);

    // Mount or remount the connector if enabled.
    const rc = this.running.get(id);
    if (rc) { if (rc.pullTimer) clearInterval(rc.pullTimer); this.running.delete(id); }
    if (cfg.enabled) this.mountConnector(cfg);

    // Restart webhook server when a new webhook connector is added.
    await this.startWebhookServerIfNeeded();

    return cfg;
  }

  /** Remove a connector. */
  async remove(id: string): Promise<void> {
    const rc = this.running.get(id);
    if (rc?.pullTimer) clearInterval(rc.pullTimer);
    this.running.delete(id);
    const newConfigs = this.settings.configs.filter(c => c.id !== id);
    await this.persistConfigs(newConfigs);
  }

  /** Manually trigger a pull for a specific connector. Returns ingested event count. */
  async triggerPull(id: string): Promise<{ eventsIngested: number }> {
    const cfg = this.settings.configs.find(c => c.id === id);
    if (!cfg) throw new Error(`Connector '${id}' not found`);
    const rc = this.running.get(id);
    if (!rc) throw new Error(`Connector '${id}' is not running (disabled or not started)`);
    if (!rc.connector.pull) throw new Error(`Connector '${id}' (${cfg.kind}) is push-only (no pull method)`);
    const count = await this.doPull(cfg, rc);
    return { eventsIngested: count };
  }

  /** Get the OAuth authorization URL for a connector. */
  getAuthUrl(id: string): { url: string; note?: string } {
    const cfg = this.settings.configs.find(c => c.id === id);
    if (!cfg) throw new Error(`Connector '${id}' not found`);
    const connector = buildConnector(cfg);
    if (!connector.getAuthUrl) {
      throw new Error(`Connector '${id}' (${cfg.kind}) does not use OAuth`);
    }
    const callbackUrl = `http://${this.settings.webhookHost === '0.0.0.0' ? 'localhost' : this.settings.webhookHost}:${this.settings.webhookPort}/oauth/${id}/callback`;
    const url = connector.getAuthUrl(callbackUrl);
    const note = cfg.kind === 'trello'
      ? 'Trello will show you the token on the page — copy it and update credentials.token in connector settings.'
      : `After approving, Graphnosis will capture the token automatically via the callback at ${callbackUrl}`;
    return { url, note };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private mountConnector(cfg: ConnectorConfig): void {
    const connector = buildConnector(cfg);
    const hasPull = typeof connector.pull === 'function';
    const pullTimer = hasPull
      ? setInterval(() => {
          void this.doPull(cfg, rc).catch(err => {
            console.error(`[connector:${cfg.id}] scheduled pull failed: ${(err as Error).message}`);
          });
        }, this.settings.pullIntervalMs).unref()
      : null;

    const rc: RunningConnector = { connector, pullTimer, eventsTotal: 0, pulling: false };
    this.running.set(cfg.id, rc);

    // Run an immediate pull on mount so the engram is populated right away.
    if (hasPull) {
      void this.doPull(cfg, rc).catch(err => {
        console.error(`[connector:${cfg.id}] initial pull failed: ${(err as Error).message}`);
      });
    }
  }

  private async doPull(cfg: ConnectorConfig, rc: RunningConnector): Promise<number> {
    if (rc.pulling) return 0; // Don't overlap pulls
    rc.pulling = true;
    const since = cfg.lastPulledAt ? new Date(cfg.lastPulledAt) : undefined;
    try {
      const events = await rc.connector.pull!(since);
      const count = await this.ingestEvents(cfg, events);
      rc.eventsTotal += count;
      // Persist lastPulledAt + clear lastError
      await this.updateConnectorState(cfg.id, { lastPulledAt: Date.now(), lastError: undefined });
      return count;
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[connector:${cfg.id}] pull error: ${msg}`);
      await this.updateConnectorState(cfg.id, { lastError: msg });
      return 0;
    } finally {
      rc.pulling = false;
    }
  }

  private async ingestEvents(cfg: ConnectorConfig, events: ConnectorEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    let count = 0;
    for (const ev of events) {
      try {
        await withEmbedding(() =>
          ingestClip(this.host, cfg.graphId, ev.text, ev.label, {
            addedBy: `connector:${cfg.kind}`,
            sourceKind: ev.sourceKind ?? 'clip',
            triggeredBy: `connector:${cfg.kind}`,
          }),
        );
        count++;
      } catch (err) {
        console.error(`[connector:${cfg.id}] ingest failed for ${ev.sourceRef}: ${(err as Error).message}`);
      }
    }
    return count;
  }

  private async startWebhookServerIfNeeded(): Promise<void> {
    const hasWebhookConnector = this.settings.configs.some(
      c => c.enabled && (c.kind === 'webhook' || buildConnector(c).handleWebhook),
    );
    const hasOAuthConnector = this.settings.configs.some(
      c => c.enabled && buildConnector(c).getAuthUrl,
    );

    if (!hasWebhookConnector && !hasOAuthConnector) return;
    if (this.webhookServer) return; // already running

    this.webhookServer = await startWebhookHttpServer(
      this.settings.webhookPort,
      this.settings.webhookHost,
      this,
    );
  }

  /** Called by the webhook HTTP server when a request arrives. */
  async handleWebhookRequest(
    connectorId: string,
    token: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<ConnectorEvent[]> {
    const cfg = this.settings.configs.find(c => c.id === connectorId);
    if (!cfg) throw new Error(`Unknown connector: ${connectorId}`);

    // Validate the per-connector token to prevent path enumeration.
    const expectedToken = cfg.options['webhookToken'] as string | undefined;
    if (expectedToken && token !== expectedToken) {
      throw new Error('Invalid webhook token');
    }

    const rc = this.running.get(connectorId);
    const connector = rc?.connector ?? buildConnector(cfg);
    if (!connector.handleWebhook) throw new Error(`Connector '${connectorId}' does not support webhooks`);

    const events = await connector.handleWebhook(body, headers);
    if (rc) {
      await this.ingestEvents(cfg, events);
      rc.eventsTotal += events.length;
    }
    return events;
  }

  /** Called by the webhook HTTP server when an OAuth callback arrives. */
  async handleOAuthCallback(connectorId: string, code: string, state: string): Promise<void> {
    const cfg = this.settings.configs.find(c => c.id === connectorId);
    if (!cfg) throw new Error(`Unknown connector: ${connectorId}`);
    const connector = buildConnector(cfg);
    if (!connector.handleOAuthCallback) throw new Error(`Connector '${connectorId}' does not support OAuth`);
    const credentials = await connector.handleOAuthCallback(code, state);
    // Merge new credentials and persist.
    const updated = { ...cfg, credentials };
    const newConfigs = this.settings.configs.map(c => c.id === connectorId ? updated : c);
    await this.persistConfigs(newConfigs);
    console.error(`[connector:${connectorId}] OAuth credentials stored`);
  }

  private async updateConnectorState(
    id: string,
    patch: { lastPulledAt?: number; lastError?: string | undefined },
  ): Promise<void> {
    const newConfigs: ConnectorConfig[] = this.settings.configs.map(c => {
      if (c.id !== id) return c;
      // patch.lastError can be `undefined` to mean "clear it"; we represent
      // that on-disk by omitting the field. Build the next config without
      // the field if patch.lastError is explicitly undefined.
      const { lastError: _oldLastError, ...rest } = c;
      const next: ConnectorConfig = {
        ...rest,
        ...(patch.lastPulledAt !== undefined ? { lastPulledAt: patch.lastPulledAt } : {}),
        ...('lastError' in patch && patch.lastError !== undefined
          ? { lastError: patch.lastError }
          : c.lastError !== undefined && !('lastError' in patch)
            ? { lastError: c.lastError }
            : {}),
      };
      return next;
    });
    await this.persistConfigs(newConfigs);
  }

  private async persistConfigs(configs: ConnectorConfig[]): Promise<void> {
    this.settings = { ...this.settings, configs };
    await this.host.setSettings({ connectors: this.settings });
  }
}

// ── Connector factory ─────────────────────────────────────────────────────────

function buildConnector(cfg: ConnectorConfig): Connector {
  switch (cfg.kind) {
    case 'webhook': return new WebhookConnector(cfg);
    case 'rss':     return new RssConnector(cfg);
    case 'github':  return new GitHubConnector(cfg);
    case 'slack':   return new SlackConnector(cfg);
    case 'trello':   return new TrelloConnector(cfg);
    case 'linear':   return new LinearConnector(cfg);
    case 'obsidian': return new ObsidianConnector(cfg);
    case 'gbrain':      return new GBrainConnector(cfg);
    case 'ai-context':  return new AiContextConnector(cfg);
    default: throw new Error(`Unknown connector kind: ${(cfg as ConnectorConfig).kind}`);
  }
}

// ── Webhook HTTP server ───────────────────────────────────────────────────────

async function startWebhookHttpServer(
  port: number,
  host: string,
  manager: ConnectorManager,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    // ── OAuth callback: GET /oauth/<connectorId>/callback?code=…&state=… ──
    const oauthMatch = url.match(/^\/oauth\/([^/]+)\/callback/);
    if (oauthMatch && req.method === 'GET') {
      const connectorId = decodeURIComponent(oauthMatch[1]!);
      const qs = new URL(url, `http://${host}`).searchParams;
      const code = qs.get('code') ?? '';
      const state = qs.get('state') ?? '';
      try {
        await manager.handleOAuthCallback(connectorId, code, state);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Graphnosis: authentication complete. You can close this tab.</h2>');
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth error: ${(err as Error).message}`);
      }
      return;
    }

    // ── Webhook push: POST /webhook/<connectorId>/<token> ──────────────────
    const webhookMatch = url.match(/^\/webhook\/([^/]+)\/([^/?]+)/);
    if (webhookMatch && req.method === 'POST') {
      const connectorId = decodeURIComponent(webhookMatch[1]!);
      const token = decodeURIComponent(webhookMatch[2]!);
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON body');
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      try {
        const events = await manager.handleWebhookRequest(connectorId, token, body, headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, eventsIngested: events.length }));
      } catch (err) {
        const msg = (err as Error).message;
        const status = msg.includes('Invalid webhook token') || msg.includes('Unknown connector') ? 403 : 500;
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(msg);
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('error', (err) => {
    console.error(`[connectors] webhook server error: ${err.message}`);
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.error(`[graphnosis-sidecar] connector webhook server on http://${host}:${port}`);
      resolve(server);
    });
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { buf += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function slugify(kind: string): string {
  return `${kind}-${randomUUID().slice(0, 8)}`;
}
