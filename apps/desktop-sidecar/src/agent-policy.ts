// Ghampus policy gate. Every tool call passes through this module before
// the tool implementation runs. Phase 4 narrowed the scope dramatically:
//   - Ghampus itself has NO global license gate. The agent surface is
//     usable by every plan, mirroring the way external MCP clients work.
//   - The kill switch is the only thing this module enforces.
//   - Per-tool license checks (`foresight` for develop/predict/insights,
//     `skill-training` for train_skill, etc.) live INSIDE each tool
//     handler in `agent-tools.ts` so they match the MCP server's gating
//     exactly. Same error messages, same upgrade prompts as external
//     clients.
//
// Future phases add to this file:
//   - Per-call rate limits (mirrors enforceRecallRateLimit in mcp-server).
//   - Industrial policy gates (sharing.outbound.allowed, etc.).

import type { GraphnosisHost } from './host.js';
import type { LicenseValidator } from './license-validator.js';
import type { AgentToolName } from './agent-types.js';

export interface AgentPolicyDeps {
  host: Pick<GraphnosisHost, 'getSettings' | 'getLicenseToken'>;
  licenseValidator: LicenseValidator | undefined;
}

export class AgentPolicyError extends Error {
  constructor(readonly reason: 'killed', message: string) {
    super(message);
    this.name = 'AgentPolicyError';
  }
}

/**
 * Throws an `AgentPolicyError` when the kill switch is engaged. Callers
 * should catch it, log via `appendAuditEntry({ policyDenied: true,
 * policyReason: err.reason })`, and surface the message to the user.
 *
 * Per-tool license enforcement is the tool handler's job, not ours —
 * `agent-tools.ts` checks `hasFeature(...)` inline for tools that need
 * a paid feature, throwing the same error external clients would see.
 */
export function assertCanInvokeTool(deps: AgentPolicyDeps, _tool: AgentToolName): void {
  if (deps.host.getSettings().agent?.enabled === false) {
    throw new AgentPolicyError(
      'killed',
      'Ghampus is disabled by the user kill switch. Re-enable from the menu-bar tray or the Ghampus tab.',
    );
  }
}
