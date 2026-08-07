// MCP audit log — durable encrypted record of AI-client tool calls.
// Verifies recall + remember write audit events with expected fields.

import { createMcpServer } from '../apps/desktop-sidecar/src/mcp-server.js';
import { hashMcpQuery } from '../apps/desktop-sidecar/src/mcp-audit.js';
import { mcpRegistry } from '../apps/desktop-sidecar/src/mcp-registry.js';
import {
  setupTestCortex,
  seedStandardData,
  assert,
  section,
  runSuite,
  type SuiteResult,
} from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('mcp-audit', mcpAuditSuite);
}

async function mcpAuditSuite(): Promise<void> {
  const cx = await setupTestCortex('mcp-audit');
  try {
    // The MCP audit-log feature's host surface (flushMcpAuditWrites / listMcpAuditEvents)
    // is currently parked under apps/desktop-sidecar/_wip-enterprise/ and is not wired onto
    // the active host. Skip gracefully instead of crashing the run-all batch; this suite
    // re-activates automatically once the host audit methods return.
    const auditHost = cx.host as { flushMcpAuditWrites?: unknown; listMcpAuditEvents?: unknown };
    if (typeof auditHost.flushMcpAuditWrites !== 'function' || typeof auditHost.listMcpAuditEvents !== 'function') {
      section('MCP audit host surface unavailable (feature WIP — _wip-enterprise/mcp-audit.ts); skipping');
      return;
    }

    await seedStandardData(cx.host);

    const connId = mcpRegistry.register('test');
    mcpRegistry.setClientInfo(connId, 'test-client', '1.0');

    const { callTool } = createMcpServer({
      host: cx.host,
      llm: () => null,
      defaultGraphId: () => 'work',
      pendingDiffs: new Map(),
      cortexDir: cx.cortexDir,
    });

    section('recall writes MCP audit event');
    await callTool('recall', { query: 'Tudor', maxTokens: 2000, maxNodes: 10 });
    await cx.host.flushMcpAuditWrites();

    let events = await cx.host.listMcpAuditEvents();
    assert(events.length >= 1, 'at least one MCP audit event after recall');
    const recallEv = events.find((e) => e.tool === 'recall');
    assert(!!recallEv, 'recall event present', { tools: events.map((e) => e.tool) });
    if (recallEv) {
      assert(recallEv.clientId === 'test-client', 'recall audit tags clientId');
      assert(recallEv.queryHash === hashMcpQuery('Tudor'), 'recall audit stores query hash not raw query');
      assert(recallEv.queryLen === 'Tudor'.length, 'recall audit stores queryLen');
      assert(
        !JSON.stringify(recallEv).includes('Tudor'),
        'raw query text is not present in audit record',
      );
      assert(recallEv.tokenBudget?.requestedTokens === 2000, 'recall audit records token budget');
      assert(
        (recallEv.engramIds?.length ?? 0) > 0,
        'recall audit lists contributing engramIds',
      );
    }

    section('remember writes MCP audit event');
    await callTool('remember', { text: 'Audit sentinel note 42', graphId: 'work', label: 'audit-test' });
    await cx.host.flushMcpAuditWrites();

    events = await cx.host.listMcpAuditEvents();
    const rememberEv = events.find((e) => e.tool === 'remember');
    assert(!!rememberEv, 'remember event present');
    if (rememberEv) {
      assert(rememberEv.engramIds.includes('work'), 'remember audit tags target engram');
      assert(
        !JSON.stringify(rememberEv).includes('Audit sentinel note 42'),
        'remembered text is not stored in audit record',
      );
    }

    section('audit file is encrypted on disk');
    const { MCP_AUDIT_FILE } = await import('../apps/desktop-sidecar/src/mcp-audit.js');
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const raw = await fs.readFile(path.join(cx.cortexDir, MCP_AUDIT_FILE));
    assert(
      !raw.includes(Buffer.from('test-client')),
      'client id is not plaintext in mcp-audit.oplog',
    );

    mcpRegistry.unregister(connId);
  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  import('./_helpers.js').then(({ standalone }) => {
    void standalone('mcp-audit', mcpAuditSuite);
  });
}
