// App-specific glue. Security and sync primitives now live in
// @nehloo-interactive/graphnosis-secure-sync.

export * as sources from './sources/index.js';
export * as embeddings from './embeddings/index.js';
export * as settings from './settings/index.js';

// Source tracking types are App-specific and stay here.
export type { SourceId, SourceRecord } from './types.js';

// Connector types are used by the sidecar's connector subsystem.
export type { ConnectorKind, ConnectorConfig, ConnectorSettings } from './settings/index.js';

// Shared infrastructure types are re-exported from the extracted package
// so existing call sites keep working with @graphnosis-app/core imports.
export type {
  DeviceId,
  GraphId,
  NodeId,
  OpKind,
  OpLogEvent,
  SubgraphBudget,
} from '@nehloo-interactive/graphnosis-secure-sync';
