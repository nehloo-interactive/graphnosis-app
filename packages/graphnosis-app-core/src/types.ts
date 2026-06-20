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
  kind: 'file' | 'url' | 'ai-conversation' | 'clip' | 'skill';
  ref: string;
  ingestedAt: number;
  graphId: GraphId;
  nodeIds: NodeId[];
  contentHash?: string;
  /**
   * Who added or last corrected this source. Set when the ingest or
   * correction came from an MCP client (e.g. "claude-ai", "cursor",
   * "claude-code"); undefined when the user added it directly via the
   * app UI (drag-drop, paste, file picker). Free-form string — comes
   * from the MCP `initialize` handshake's `clientInfo.name`.
   */
  addedBy?: string;
  /**
   * Legal hold — when true, forget / edit / transfer on this source is
   * blocked until the hold is released. Persisted in the encrypted bundle;
   * toggling emits a `setLegalHold` op-log event for audit.
   */
  legalHold?: boolean;
  /** Unix ms when legal hold was last placed ON. Cleared when released. */
  legalHoldAt?: number;
  /** Optional matter / case label shown in compliance exports. */
  legalHoldMatter?: string;
}
