// Shared types for the Ghampus runtime (sidecar side).
//
// Phase 3 lands the policy/tools/audit foundation; the LLM-driven turn loop
// and conversation persistence ship later and consume these same types.

/**
 * Tools the agent can invoke. Phase 3 implements the read-only subset
 * (recall, stats, list_engrams); write tools (remember, edit, forget) are
 * declared here so the registry has a stable surface, but their handlers
 * throw "not implemented" until the correction-flow integration lands.
 */
export type AgentToolName =
  | 'recall'
  | 'stats'
  | 'list_engrams'
  | 'list_skills'
  | 'remember'
  | 'edit'
  | 'forget';

export interface AgentToolCallRecord {
  /** Tool name as it appeared in the request. */
  tool: AgentToolName;
  /** Caller-provided arguments. Logged verbatim — never include secrets. */
  args: Record<string, unknown>;
  /** Result payload returned to the caller, or null when the call threw. */
  result: unknown;
  /** Error message when the call failed; absent on success. */
  error?: string;
  /** Unix-ms timestamp at the moment the runtime accepted the call. */
  startedAt: number;
  /** Duration in milliseconds, end-to-end including policy + audit. */
  durationMs: number;
}

/**
 * One line in the agent audit log. Written append-only to
 * `<cortex>/agent-audit.jsonl` after every accepted tool call (and after
 * policy-denied calls — the denial itself is auditable). Mirrors the
 * MCP-level audit pattern in `mcp-server.ts` console.error lines, but as
 * structured JSON the inspector can read.
 */
export interface AgentAuditEntry extends AgentToolCallRecord {
  /** Conversation id when the call originated inside a chat turn. */
  conversationId?: string;
  /** Whether the policy gate denied the call before the tool ran. */
  policyDenied?: boolean;
  /** The denial reason when policyDenied is true. */
  policyReason?: string;
}

/**
 * Conversation envelope. Phase 3 declares the shape; persistence and the
 * LLM-driven append loop land in a follow-up. Messages are append-only.
 */
export interface AgentConversation {
  id: string;
  createdAt: number;
  /** Engram (graphId) the conversation is bound to. null = federated scope. */
  graphId: string | null;
  messages: AgentMessage[];
}

export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AgentToolCallRecord[] };
