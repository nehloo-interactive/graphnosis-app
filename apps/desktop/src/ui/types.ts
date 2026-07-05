/** Types shared across UI domain modules (mirrors Rust / sidecar shapes). */

export interface StatusSnapshot {
  unlocked: boolean;
  cortex_dir: string | null;
  sidecar_running: boolean;
  sso_session?: { role: string; email?: string | null } | null;
}

/** Result of probing Touch ID readiness for a cortex path (Tauri desktop). */
export interface BiometricStatus {
  available: boolean;
  has_saved_passphrase: boolean;
  hardware_available: boolean;
  /** User-facing hint when `available` is false; omitted when Touch ID is ready. */
  hint?: string | null;
}

export interface GraphMetadata {
  displayName: string;
  template: string;
  archived?: boolean;
  sensitivity?: 'public' | 'personal' | 'sensitive';
  /**
   * Per-engram (Agempus) execution-autonomy override — mirrors the core
   * GraphMetadata field. Absent → the engram inherits the global level.
   * Resolved/capped server-side; see resolveEngramAutonomyLevel and
   * the `graphs.setExecutionAutonomy` IPC setter.
   */
  executionAutonomyLevel?: 'L0' | 'L1' | 'L2' | 'L3';
  /**
   * Quarantine marker for engrams created by an untrusted IMPORT (#39). While
   * present with any item still in the 'quarantined' state the engram is
   * QUARANTINED — excluded at the host boundary from recall/dispatch/cross-skill
   * resolution, and (feature #41) from the Agents roster. Mirrors core
   * GraphMetadata.quarantine; resolve via host.isQuarantined server-side.
   */
  quarantine?: {
    fromPack: string;
    signerPublicKey?: string;
    verified: boolean;
    importedAt: number;
    items: Array<{ sourceId: string; lint?: string[]; state: 'quarantined' | 'promoted' | 'rejected' }>;
  };
}

export interface GraphWithMetadata {
  graphId: string;
  metadata: GraphMetadata;
  loaded?: boolean;
}

export interface OpLogEvent {
  id: string;
  ts: number;
  deviceId: string;
  sessionId: string;
  graphId: string;
  op: 'addNode' | 'editNode' | 'deleteNode' | 'addEdge' | 'deleteEdge' | 'supersede' | 'merge' | 'ingestSource' | 'forgetSource';
  target: { kind: 'node' | 'edge' | 'source'; id: string };
  before?: unknown;
  after?: unknown;
  resolved?: { target?: string; from?: string; to?: string };
  actor?: string;
  actorCls?: string;
  targetSourceId?: string;
}

export interface SnapshotInfo {
  id: string;
  createdAt: number;
  sizeBytes: number;
  fileCount: number;
}

export type ConnectorKind =
  | 'webhook' | 'rss' | 'github' | 'slack' | 'trello' | 'linear'
  | 'obsidian' | 'gbrain' | 'ai-context' | 'x';

export interface ConnectorConfigShape {
  id: string;
  kind: ConnectorKind;
  graphId: string;
  enabled: boolean;
  credentials: Record<string, string>;
  options: Record<string, unknown>;
  lastPulledAt?: number;
  lastError?: string;
}

export interface ConnectorStatus {
  id: string;
  kind: string;
  enabled: boolean;
  lastPulledAt?: number;
  lastError?: string;
  eventsTotal: number;
  pulling: boolean;
}

export type ForgetMode = 'soft' | 'purge';
export type ContentCacheMode = 'all' | 'ephemeral-only' | 'off';

export interface NodeRecord {
  id: string;
  contentPreview?: string;
  [key: string]: unknown;
}
