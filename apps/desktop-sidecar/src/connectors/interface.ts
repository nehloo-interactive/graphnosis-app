export type { ConnectorKind, ConnectorConfig, ConnectorSettings } from '@graphnosis-app/core';

/** A single item produced by a connector pull or webhook push. */
export interface ConnectorEvent {
  /** Plain-text body that will be stored as a memory node. */
  text: string;
  /**
   * Stable unique reference for this item. Used as the `sourceRef` so
   * re-pulling the same item is a no-op (same SourceId ⇒ already exists).
   */
  sourceRef: string;
  /** Human-friendly label for the node (title, subject line, card name…). */
  label: string;
  sourceKind?: 'clip' | 'ai-conversation';
}

/** Runtime status exposed to the App's connector panel via IPC. */
export interface ConnectorStatus {
  id: string;
  kind: string;
  enabled: boolean;
  lastPulledAt?: number;
  lastError?: string;
  eventsTotal: number;
  pulling: boolean;
}

/**
 * Each connector kind implements this interface. The manager creates one
 * instance per ConnectorConfig and routes lifecycle calls to it.
 */
export interface Connector {
  readonly config: import('@graphnosis-app/core').ConnectorConfig;

  /**
   * Fetch new events since `since`. Called on the pull schedule and on
   * demand via `connectors.triggerPull`. Optional — webhook-only connectors
   * omit this.
   */
  pull?(since?: Date): Promise<ConnectorEvent[]>;

  /**
   * Handle an inbound webhook POST body. Called by the manager's HTTP
   * server when a request arrives at `/webhook/<connectorId>/<token>`.
   * Optional — pull-only connectors omit this.
   */
  handleWebhook?(body: unknown, headers: Record<string, string>): Promise<ConnectorEvent[]>;

  /**
   * Return the OAuth authorization URL to redirect the user to.
   * Optional — API-key connectors omit this.
   */
  getAuthUrl?(callbackUrl: string): string;

  /**
   * Exchange an OAuth authorization code for credentials and return them.
   * The manager stores the returned object in `config.credentials`.
   */
  handleOAuthCallback?(code: string, state: string): Promise<Record<string, string>>;
}
