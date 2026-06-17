// Ghampus policy gate. Every tool call passes through this module before
// the tool implementation runs. Phase 3 enforces the two foundational
// invariants:
//   1. The user's kill switch (settings.agent.enabled) is on.
//   2. The license JWT carries `ghampus`, `teams`, or `enterprise`.
// Future phases add:
//   - Per-call rate limits (mirrors enforceRecallRateLimit in mcp-server).
//   - Industrial policy gates (sharing.outbound.allowed, etc.).
//
// Both checks must pass; otherwise the call is rejected before any side
// effect runs. The same `agent-audit` layer records the denial.

import type { GraphnosisHost } from './host.js';
import type { LicenseValidator, LicenseFeature } from './license-validator.js';
import type { AgentToolName } from './agent-types.js';

export interface AgentPolicyDeps {
  host: Pick<GraphnosisHost, 'getSettings' | 'getLicenseToken'>;
  licenseValidator: LicenseValidator | undefined;
}

export class AgentPolicyError extends Error {
  constructor(readonly reason: 'killed' | 'gated', message: string) {
    super(message);
    this.name = 'AgentPolicyError';
  }
}

/**
 * Throws an `AgentPolicyError` when the call must not proceed. Callers
 * should catch it, log via `appendAuditEntry({ policyDenied: true,
 * policyReason: err.reason })`, and surface the message to the user.
 *
 * The kill switch check fires before the license check so users who flip
 * the switch get the right error (`killed`, not `gated`) regardless of
 * subscription state.
 */
export async function assertCanInvokeTool(deps: AgentPolicyDeps, _tool: AgentToolName): Promise<void> {
  if (deps.host.getSettings().agent?.enabled === false) {
    throw new AgentPolicyError(
      'killed',
      'Ghampus is disabled by the user kill switch. Re-enable from the menu-bar tray or the Ghampus tab.',
    );
  }
  const token = await deps.host.getLicenseToken();
  const has = (f: LicenseFeature): boolean => deps.licenseValidator?.hasFeature(token, f) ?? false;
  if (!has('ghampus') && !has('teams') && !has('enterprise')) {
    throw new AgentPolicyError(
      'gated',
      'Ghampus requires the Teams or Enterprise plan. Upgrade at https://graphnosis.app/pricing',
    );
  }
  // Write tools (`remember`/`edit`/`forget`) are declared but their handlers
  // throw `AgentToolNotImplementedError`. We let the call through here —
  // policy is about authorization, not capability.
}
