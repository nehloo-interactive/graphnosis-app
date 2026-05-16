// App-specific types. Shared infrastructure types (DeviceId, GraphId, NodeId,
// OpKind, OpLogEvent, SubgraphBudget) live in
// @nehloo-interactive/graphnosis-secure-sync — re-exported through
// ./index.ts for backwards compatibility.

import type { GraphId, NodeId } from '@nehloo-interactive/graphnosis-secure-sync';

// Re-export so internal files (sources/) can keep importing from '../types.js'.
export type { GraphId, NodeId };

export type SourceId = string;

export interface SourceRecord {
  sourceId: SourceId;
  kind: 'file' | 'url' | 'ai-conversation' | 'clip';
  ref: string;
  ingestedAt: number;
  graphId: GraphId;
  nodeIds: NodeId[];
  contentHash?: string;
}
