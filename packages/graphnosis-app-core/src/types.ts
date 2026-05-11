export type DeviceId = string;
export type GraphId = string;
export type NodeId = string;
export type SourceId = string;

export type OpKind =
  | 'addNode'
  | 'editNode'
  | 'deleteNode'
  | 'addEdge'
  | 'deleteEdge'
  | 'supersede'
  | 'merge'
  | 'ingestSource'
  | 'forgetSource';

export interface OpLogEvent {
  id: string;
  ts: number;
  deviceId: DeviceId;
  sessionId: string;
  graphId: GraphId;
  op: OpKind;
  target: { kind: 'node' | 'edge' | 'source'; id: string };
  before?: unknown;
  after?: unknown;
}

export interface SourceRecord {
  sourceId: SourceId;
  kind: 'file' | 'url' | 'ai-conversation' | 'clip';
  ref: string;
  ingestedAt: number;
  graphId: GraphId;
  nodeIds: NodeId[];
  contentHash?: string;
}

export interface SubgraphBudget {
  maxTokens: number;
  maxNodes: number;
  perGraphMinTokens?: number;
}
