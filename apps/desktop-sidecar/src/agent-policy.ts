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
import { resolveUnattendedExecutorEnabled } from '@graphnosis-app/core/settings';

export interface AgentPolicyDeps {
  host: Pick<GraphnosisHost, 'getSettings' | 'getLicenseToken'>;
  licenseValidator: LicenseValidator | undefined;
}

export class AgentPolicyError extends Error {
  constructor(readonly reason: 'killed' | 'unattended-not-allowed', message: string) {
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

/**
 * Shared enforcement point for the true L3 UNATTENDED executor. SAFETY-CRITICAL:
 * throws unless BOTH the global kill switch is off (`agent.enabled !== false`)
 * AND the owner has explicitly opted in (`agent.unattendedExecutor.enabled ===
 * true`). The executor calls this just before it starts a walk — a last-line
 * check so a kill-switch / opt-in flip between the admission gate and the walk
 * cannot let an unattended run proceed. Any future caller of the unattended
 * surface shares this one gate (parity with assertCanInvokeTool's kill switch).
 */
export function assertUnattendedAllowed(deps: Pick<AgentPolicyDeps, 'host'>): void {
  const agent = deps.host.getSettings().agent;
  if (agent?.enabled === false) {
    throw new AgentPolicyError(
      'killed',
      'Ghampus is disabled by the user kill switch — the unattended executor will not run.',
    );
  }
  if (!resolveUnattendedExecutorEnabled(agent)) {
    throw new AgentPolicyError(
      'unattended-not-allowed',
      'The unattended executor is not opted in. Enable it explicitly in Settings → Ghampus → Unattended.',
    );
  }
}
