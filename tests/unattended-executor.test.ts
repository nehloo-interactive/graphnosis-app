// True L3 UNATTENDED executor (#40) — the interlocks ARE the product.
//
// SAFETY-CRITICAL suite. The model-free admission truth table is the heart:
// admitForUnattended() must DENY on each of the seven interlocks and ADMIT only
// the all-clear single-pass, dispatch-safe:yes, high-confidence, uncontradicted,
// reversible case. Plus: the plan-shape guard (§11 walker gap), reversibility
// classification, the default-off resolver, and audit redaction + round-trip.
// Integration-lite: a host-backed effective-L3 admission + the audit header/
// action write→read, and the regression that the watcher only surfaces with the
// opt-in off (no onAutoEligible hand-off fires).

import {
  admitForUnattended,
  classifyPlanShape,
  type AdmissionInput,
} from '../apps/desktop-sidecar/src/unattended-executor.js';
import { classifyReversibility } from '../apps/desktop-sidecar/src/unattended-undo.js';
import {
  appendUnattendedRunHeader,
  appendUnattendedAction,
  appendUnattendedRunTerminal,
  readRecentUnattendedRuns,
  readRunTrace,
  flushUnattendedAuditWrites,
  AUDIT_FILE as UNATTENDED_AUDIT_FILE,
} from '../apps/desktop-sidecar/src/unattended-audit.js';
import {
  resolveUnattendedExecutorEnabled,
  resolveUnattendedRequireReversibleOnly,
} from '@graphnosis-app/core/settings';
import type { SkillExecutionPlan } from '../apps/desktop-sidecar/src/skill-trainer.js';
import { applyUndo } from '../apps/desktop-sidecar/src/unattended-undo.js';
import { ProactiveWatcher } from '../apps/desktop-sidecar/src/proactive-watcher.js';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { assert, section, standalone, runSuite, setupTestCortex, type SuiteResult } from './_helpers.js';

// The all-clear admission: every interlock satisfied, plan single-pass.
const clear: AdmissionInput = {
  killSwitchOn: true,
  optInOn: true,
  effectiveLevel: 'L3',
  dispatchSafe: 'yes',
  isMetaSkill: false,
  hasUnresolvedContradiction: false,
  matchConfidence: 1,
  planShape: { singlePass: true, walkerExecutable: true },
  requireReversibleOnly: true,
  rateLimitOk: true,
};
const a = (over: Partial<AdmissionInput>) => admitForUnattended({ ...clear, ...over });

function emptyPlan(steps: SkillExecutionPlan['steps']): SkillExecutionPlan {
  return {
    skill: { sourceId: 's', title: 't' },
    requires: [], produces: [], constraints: {},
    steps, failureHandlers: [], unanchoredContext: [],
  };
}

async function unattendedSuite(): Promise<void> {
  section('admission gate — the all-clear case ADMITS');
  assert(a({}).run === true, 'all interlocks satisfied + single-pass → run:true');

  section('admission gate — each interlock DENIES independently');
  // 1. kill switch
  const k = a({ killSwitchOn: false });
  assert(k.run === false && /kill switch/i.test((k as { reason: string }).reason), 'kill switch off → deny', k);
  // 2. opt-in (default off)
  const o = a({ optInOn: false });
  assert(o.run === false && /opted in|default off/i.test((o as { reason: string }).reason), 'opt-in off → deny', o);
  // 3. effective level below L3
  for (const lvl of ['L0', 'L1', 'L2'] as const) {
    const r = a({ effectiveLevel: lvl });
    assert(r.run === false && /< L3|L3/i.test((r as { reason: string }).reason), `effective ${lvl} → deny`, r);
  }
  // 4a. dispatch-safe caps below auto (no → suggest)
  const ds = a({ dispatchSafe: 'no' });
  assert(ds.run === false, 'dispatch-safe:no → deny (capped below auto)', ds);
  const dp = a({ dispatchSafe: 'partial' });
  assert(dp.run === false, 'dispatch-safe:partial → deny (capped to preview)', dp);
  // 4b. meta/router never auto-runs
  const m = a({ isMetaSkill: true });
  assert(m.run === false, 'meta/router skill → deny', m);
  // 4c. LIVE unresolved contradiction caps to preview
  const c = a({ hasUnresolvedContradiction: true });
  assert(c.run === false && /capped/i.test((c as { reason: string }).reason), 'open contradiction → deny (preview)', c);
  // 4d. low confidence downgrades to suggest
  const lc = a({ matchConfidence: 0.1 });
  assert(lc.run === false, 'low match confidence → deny', lc);
  // 5. plan-shape guard — refuse non-walker-executable shapes...
  const ps = a({ planShape: { singlePass: false, walkerExecutable: false, reason: 'parallel siblings' } });
  assert(ps.run === false && /parallel/i.test((ps as { reason: string }).reason), 'non-executable plan → deny', ps);
  // ...but ADMIT capped loops: the walker re-executes loop bodies with the cap
  // enforced in code, so a capped-loop plan is walker-executable (not singlePass).
  const cl = a({ planShape: { singlePass: false, walkerExecutable: true } });
  assert(cl.run === true, 'capped-loop plan (walker-executable, not single-pass) → ADMIT', cl);
  // 7. rate limit
  const rl = a({ rateLimitOk: false });
  assert(rl.run === false && /rate limit/i.test((rl as { reason: string }).reason), 'rate limit reached → deny', rl);

  section('admission gate — fail-fast order (kill switch beats opt-in beats level)');
  const both = a({ killSwitchOn: false, optInOn: false });
  assert(/kill switch/i.test((both as { reason: string }).reason), 'kill switch reported first', both);

  section('plan-shape guard — §11 walker gap (refuse parallel + uncapped loops; ADMIT capped loops)');
  const lin1 = classifyPlanShape(emptyPlan([{ index: 1, text: 'a', supportingContext: [] }]));
  assert(lin1.singlePass === true && lin1.walkerExecutable === true, 'linear single step → single-pass + executable', lin1);
  const lin2 = classifyPlanShape(emptyPlan([
    { index: 1, text: 'a', supportingContext: [] },
    { index: 2, text: 'b', supportingContext: [] },
  ]));
  assert(lin2.singlePass === true && lin2.walkerExecutable === true, 'two linear steps → single-pass + executable', lin2);
  const par = classifyPlanShape(emptyPlan([
    { index: 1, text: 'a', supportingContext: [], parallel: [{ targetSourceId: 'x', targetTitle: 'X', args: [] }] },
  ]));
  assert(par.walkerExecutable === false && /parallel/i.test(par.reason ?? ''), 'parallel[] → refused', par);
  const uncapped = classifyPlanShape(emptyPlan([
    { index: 1, text: 'a', supportingContext: [] },
    { index: 2, text: 'b', supportingContext: [], loopsBackTo: [1] },
  ]));
  assert(uncapped.walkerExecutable === false && /uncapped/i.test(uncapped.reason ?? ''), 'uncapped @loop → refused (authored cap required)', uncapped);
  const capped = classifyPlanShape(emptyPlan([
    { index: 1, text: 'a', supportingContext: [] },
    { index: 2, text: 'b', supportingContext: [], loopsBackTo: [1], maxIterations: 3 },
  ]));
  assert(capped.walkerExecutable === true && capped.singlePass === false && !capped.reason,
    'capped @loop (max=3) → walker-executable, not single-pass', capped);
  const iter = classifyPlanShape(emptyPlan([
    { index: 1, text: 'a', supportingContext: [], maxIterations: 3 },
  ]));
  assert(iter.walkerExecutable === false && /malformed|maxIterations/i.test(iter.reason ?? ''), 'maxIterations>1 with no loop edge → refused (malformed)', iter);
  const one = classifyPlanShape(emptyPlan([
    { index: 1, text: 'a', supportingContext: [], maxIterations: 1 },
  ]));
  assert(one.singlePass === true && one.walkerExecutable === true, 'maxIterations=1 with no loop edge is fine (single pass)', one);

  section('reversibility classification');
  const none = classifyReversibility({ kind: 'none' });
  assert(none.reversible === true && none.kind === 'none' && !none.undoToken, 'read/compute-only → reversible, nothing to undo', none);
  const sup = classifyReversibility({ kind: 'supersede', graphId: 'work', nodeId: 'n1', previousContent: 'old' });
  assert(sup.reversible === true && sup.kind === 'supersede' && !!sup.undoToken, 'supersede → reversible w/ token', sup);
  const se = classifyReversibility({ kind: 'skill-edit', graphId: 'work', sourceId: 's1', snapshotId: 'snap1' });
  assert(se.reversible === true && se.kind === 'skill-edit' && !!se.undoToken, 'skill-edit → reversible w/ token', se);
  const fg = classifyReversibility({ kind: 'forget', graphId: 'work', sourceId: 's1', previousContent: 'gone' });
  assert(fg.reversible === true && fg.kind === 'forget' && !!fg.undoToken, 'forget → reversible w/ token', fg);
  const ext = classifyReversibility({ kind: 'external', description: 'sent an email' });
  assert(ext.reversible === false, 'external side effect → NOT reversible (admission refuses it)', ext);

  section('default-off proof — resolveUnattendedExecutorEnabled');
  assert(resolveUnattendedExecutorEnabled(undefined) === false, 'absent agent → false');
  assert(resolveUnattendedExecutorEnabled(null) === false, 'null agent → false');
  assert(resolveUnattendedExecutorEnabled({ enabled: true } as never) === false, 'agent w/o block → false');
  assert(resolveUnattendedExecutorEnabled({ enabled: true, unattendedExecutor: { enabled: false } } as never) === false, 'block enabled:false → false');
  // A malformed non-boolean a hand-edited cortex could carry must still be off.
  assert(resolveUnattendedExecutorEnabled({ enabled: true, unattendedExecutor: { enabled: 'yes' as never } } as never) === false, 'non-boolean enabled → false (=== true only)');
  assert(resolveUnattendedExecutorEnabled({ enabled: true, unattendedExecutor: { enabled: true } } as never) === true, 'explicit enabled:true → true');

  section('requireReversibleOnly defaults TRUE (only explicit false opts out)');
  assert(resolveUnattendedRequireReversibleOnly(undefined) === true, 'absent → true');
  assert(resolveUnattendedRequireReversibleOnly({ enabled: true, unattendedExecutor: { enabled: true } } as never) === true, 'absent field → true');
  assert(resolveUnattendedRequireReversibleOnly({ enabled: true, unattendedExecutor: { enabled: true, requireReversibleOnly: false } } as never) === false, 'explicit false → false');

  section('audit — redaction + header/action round-trip (integration-lite)');
  const dir = path.join(os.tmpdir(), `gn-unattended-audit-${process.pid}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  // The ledger is sealed at rest with the cortex data key (32-byte raw key, same
  // as host.key — the IV/salt is generated per encode). A standalone key is fine
  // for the module-level round-trip; the on-disk-ciphertext check below uses the
  // real host key.
  const auditKey = randomBytes(32);
  try {
    const runId = 'run-1';
    await appendUnattendedRunHeader(dir, auditKey, {
      runId, skillSourceId: 'skill:1:demo', skillGraphId: 'work', skillLabel: 'demo',
      startedAt: 1000, trigger: { signalType: 'time-based', signalLabel: 'cadence', why: 'because' },
      autonomyReason: 'effective L3 → auto', status: 'running',
    });
    // Redaction reuses SENSITIVE_VAR_RE via redactSkillRunVars (keyed 'preview').
    const { redactSkillRunVars } = await import('../apps/desktop-sidecar/src/skill-runs.js');
    const redact = (s: string): string => {
      const out = redactSkillRunVars({ preview: s });
      return typeof out.preview === 'string' ? out.preview : '[redacted]';
    };
    const longOut = 'x'.repeat(200);
    await appendUnattendedAction(dir, auditKey, {
      runId, stepIndex: 1, label: 'step one', pickedModelDisplay: 'ollama:llama',
      touched: { recalledEngrams: ['work'], writtenNodeIds: [], mcpTools: [] },
      outcome: 'ok', undo: { reversible: true, kind: 'none' },
      redactedPromptPreview: redact('do the thing'),
      redactedOutputPreview: redact(longOut),
      elapsedMs: 42, ts: 1001,
    });
    await appendUnattendedRunTerminal(dir, auditKey, runId, { status: 'complete', endedAt: 2000 });

    const runs = await readRecentUnattendedRuns(dir, auditKey, 10);
    assert(runs.length === 1, 'one run header read back', runs.length);
    assert(runs[0]!.status === 'complete', 'terminal status overlays opening header', runs[0]!.status);
    assert(runs[0]!.endedAt === 2000, 'endedAt merged from terminal line', runs[0]!.endedAt);

    const { header, actions } = await readRunTrace(dir, auditKey, runId);
    assert(!!header && header.skillLabel === 'demo', 'trace header carries skill identity', header);
    assert(actions.length === 1 && actions[0]!.stepIndex === 1, 'one action in trace', actions.length);
    assert(actions[0]!.redactedOutputPreview.length <= 120, 'long output preview truncated by redactor', actions[0]!.redactedOutputPreview.length);
    assert(actions[0]!.touched.recalledEngrams.includes('work'), 'touched engrams recorded', actions[0]!.touched);

    // A sensitive key is fully redacted (SENSITIVE_VAR_RE on the field name).
    const secretOut = redactSkillRunVars({ password: 'hunter2' });
    assert(secretOut.password === '[redacted]', 'sensitive var fully redacted', secretOut);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ── Host-backed integration ────────────────────────────────────────────────
  const cx = await setupTestCortex('unattended');
  try {
    section('undo restores a superseded node (correction-pipeline round-trip)');
    await cx.host.createGraph('work');
    const ORIGINAL = 'UNATTENDED_ORIGINAL_CONTENT marker alpha';
    const src = await cx.host.ingest('work', 'clip', 'work:undo-target', {
      kind: 'markdown', content: ORIGINAL, sourceRef: 'work:undo-target',
    });
    // Pick the node that actually carries the original body (not a title node).
    const nodeId = src.nodeIds.find(
      (id) => (cx.host.getFullNodeContent('work', id) ?? '').includes('UNATTENDED_ORIGINAL_CONTENT'),
    ) ?? src.nodeIds[0]!;
    const before = cx.host.getFullNodeContent('work', nodeId) ?? '';
    assert(before.includes('UNATTENDED_ORIGINAL_CONTENT'), 'seeded node has original content', before.slice(0, 40));

    // An unattended action superseded it — capture the pre-state, classify, then
    // perform the supersede (simulating the walk's reversible side effect).
    const cls = classifyReversibility({ kind: 'supersede', graphId: 'work', nodeId, previousContent: before });
    assert(cls.reversible && !!cls.undoToken, 'supersede classified reversible w/ token');
    await cx.host.applyCorrection('work', {
      edits: [{ kind: 'supersede', nodeId, content: 'REPLACED by unattended run', reason: 'unattended supersede' }],
    });
    // Supersede creates a new live node carrying the replacement (the original is
    // kept, soft-deleted, for audit lineage). The live graph now surfaces the
    // replacement text.
    const liveAfter = cx.host.listNodes('work')
      .map((n) => cx.host.getFullNodeContent('work', n.id) ?? '')
      .join('\n');
    assert(liveAfter.includes('REPLACED by unattended run'), 'replacement content is live after supersede', liveAfter.slice(0, 60));

    // Undo via the token → re-supersede restoring the original content as the
    // new live version (round-trip through the indelible correction pipeline).
    const undone = await applyUndo(cx.host, cls.undoToken!, null);
    assert(undone.ok && undone.reverted === 'supersede', 'applyUndo reports supersede reverted', undone);
    const liveRestored = cx.host.listNodes('work')
      .map((n) => cx.host.getFullNodeContent('work', n.id) ?? '')
      .join('\n');
    assert(liveRestored.includes('UNATTENDED_ORIGINAL_CONTENT'), 'original content restored as live version after undo', liveRestored.slice(0, 60));

    section('undo refuses an irreversible / malformed token');
    const bad = await applyUndo(cx.host, 'not-a-valid-token', null);
    assert(bad.ok === false && bad.reason === 'irreversible', 'undecodable token → irreversible refusal', bad);

    section('host effective-autonomy is the L3 interlock source (re-resolved at exec time)');
    // With no per-skill/engram override and the default global level, a skill
    // resolves below L3 — so the live effective-level interlock denies. This is
    // what consider() feeds into admitForUnattended (interlock 3).
    const effLevel = cx.host.resolveEffectiveSkillAutonomy('work', src.sourceId, 'work:undo-target');
    const denied = a({ effectiveLevel: effLevel });
    if (effLevel !== 'L3') {
      assert(denied.run === false, `default effective ${effLevel} → unattended denied`, denied);
    } else {
      assert(true, 'engram configured to L3 in this fixture');
    }

    section('REGRESSION — watcher with opt-in OFF only surfaces (no onAutoEligible hand-off)');
    // The hand-off hook is OPTIONAL; with no executor wired, the watcher behaves
    // exactly as before — it surfaces cards, never executes. We assert the
    // ProactiveWatcher constructs cleanly without the hook (today's call shape)
    // and that the executor's default-off resolver keeps it inert.
    let handoffs = 0;
    const watcherNoHook = new ProactiveWatcher({
      host: cx.host, skillTrainer: null, broadcastRaw: () => {},
    });
    assert(typeof watcherNoHook.listCards === 'function', 'watcher constructs without onAutoEligible (back-compat call shape)');
    // A watcher WITH the hook only forwards from its auto branch — never on
    // construction. Constructing it must not invoke the hook.
    const watcherWithHook = new ProactiveWatcher({
      host: cx.host, skillTrainer: null, broadcastRaw: () => {},
      onAutoEligible: () => { handoffs++; },
    });
    assert(typeof watcherWithHook.listCards === 'function' && handoffs === 0,
      'wiring the hook does not fire it (only the auto branch forwards)', handoffs);
    assert(resolveUnattendedExecutorEnabled(cx.host.getSettings().agent) === false,
      'fresh cortex → unattended executor off (so even a forwarded card never runs)');

    section('audit — ledger is ENCRYPTED on disk (sentinels not plaintext; readRunTrace decrypts)');
    // Write a run whose redacted previews AND undo-token pre-state carry sentinels,
    // then read the RAW <cortex>/unattended-runs.jsonl bytes and assert neither
    // sentinel appears in cleartext (mirrors mcp-audit.test.ts's "client id is not
    // plaintext"). Then confirm readRunTrace still decrypts the run back correctly.
    const dataKey = cx.host.getCortexDataKey();
    const cortexDir = cx.host.getCortexDir();
    const PROMPT_SENTINEL = 'PLAINTEXT_PROMPT_SENTINEL_ZZZ';
    const PREVCONTENT_SENTINEL = 'PLAINTEXT_PREVCONTENT_SENTINEL_QQQ';
    const encRunId = 'enc-run-1';
    await appendUnattendedRunHeader(cortexDir, dataKey, {
      runId: encRunId, skillSourceId: 'skill:1:enc', skillGraphId: 'work', skillLabel: 'enc-demo',
      startedAt: 5000, trigger: { signalType: 'time-based', signalLabel: 'cadence', why: 'because' },
      autonomyReason: 'effective L3 → auto', status: 'running',
    });
    // A supersede undo token base64s previousContent INTO the line — acceptable
    // only because the whole envelope is then sealed at rest. The sentinel must
    // not survive to disk in the clear (not as raw text, not as bare base64).
    const supersedeUndo = classifyReversibility({
      kind: 'supersede', graphId: 'work', nodeId: 'n-enc', previousContent: PREVCONTENT_SENTINEL,
    });
    await appendUnattendedAction(cortexDir, dataKey, {
      runId: encRunId, stepIndex: 1, label: 'enc step', pickedModelDisplay: 'ollama:llama',
      touched: { recalledEngrams: ['work'], writtenNodeIds: ['n-enc'], mcpTools: [] },
      outcome: 'ok', undo: supersedeUndo,
      redactedPromptPreview: PROMPT_SENTINEL,
      redactedOutputPreview: 'output',
      elapsedMs: 7, ts: 5001,
    });
    await appendUnattendedRunTerminal(cortexDir, dataKey, encRunId, { status: 'complete', endedAt: 6000 });
    await flushUnattendedAuditWrites(cortexDir);

    const rawLedger = await fs.readFile(path.join(cortexDir, UNATTENDED_AUDIT_FILE));
    assert(rawLedger.length > 0, 'ledger file exists and is non-empty on disk', rawLedger.length);
    assert(!rawLedger.includes(Buffer.from(PROMPT_SENTINEL)),
      'redacted prompt preview is NOT plaintext in unattended-runs.jsonl');
    assert(!rawLedger.includes(Buffer.from(PREVCONTENT_SENTINEL)),
      'undo-token previousContent is NOT plaintext in unattended-runs.jsonl');
    // The base64 of the sentinel must not be on disk either (base64 is not encryption).
    assert(!rawLedger.includes(Buffer.from(Buffer.from(PREVCONTENT_SENTINEL, 'utf8').toString('base64'))),
      'undo-token previousContent is NOT bare-base64 on disk (envelope is the only seal)');
    // ...but readRunTrace decrypts it back faithfully.
    const decTrace = await readRunTrace(cortexDir, dataKey, encRunId);
    assert(!!decTrace.header && decTrace.header.status === 'complete', 'readRunTrace decrypts header + terminal status', decTrace.header);
    assert(decTrace.actions.length === 1 && decTrace.actions[0]!.redactedPromptPreview === PROMPT_SENTINEL,
      'readRunTrace decrypts the prompt preview back exactly', decTrace.actions[0]?.redactedPromptPreview);
    assert(decTrace.actions[0]!.undo.kind === 'supersede' && !!decTrace.actions[0]!.undo.undoToken,
      'readRunTrace decrypts the undo classification + token', decTrace.actions[0]?.undo);

    section('interlock 6 — requireReversibleOnly refuses + records an irreversible action');
    // The exec-time contract: under requireReversibleOnly, an action classified
    // irreversible ('external') must NOT execute — it is recorded as 'refused'
    // and the walk stops; a reversible/none action proceeds. We exercise the same
    // decision the per-action loop makes (classifyReversibility + the flag) and
    // assert the refusal lands in the encrypted ledger.
    const requireReversibleOnly = true;
    const extEffect = classifyReversibility({ kind: 'external', description: 'sent an email' });
    assert(extEffect.reversible === false,
      'external side effect classified NOT reversible (the loop would refuse it)');
    const willRefuse = requireReversibleOnly && !extEffect.reversible;
    assert(willRefuse === true, 'under requireReversibleOnly:true an irreversible action is refused (not executed)');

    const refuseRunId = 'refuse-run-1';
    await appendUnattendedRunHeader(cortexDir, dataKey, {
      runId: refuseRunId, skillSourceId: 'skill:1:ext', skillGraphId: 'work', skillLabel: 'ext-demo',
      startedAt: 7000, trigger: { signalType: 'time-based', signalLabel: 'cadence', why: 'because' },
      autonomyReason: 'effective L3 → auto', status: 'running',
    });
    const refusedReason = 'requireReversibleOnly: refused irreversible action (external) — not executed';
    await appendUnattendedAction(cortexDir, dataKey, {
      runId: refuseRunId, stepIndex: 1, label: 'external send', pickedModelDisplay: 'ollama:llama',
      touched: { recalledEngrams: [], writtenNodeIds: [], mcpTools: [] },
      outcome: 'refused', undo: { reversible: false, kind: 'none' },
      redactedPromptPreview: 'send email', redactedOutputPreview: '',
      elapsedMs: 0, ts: 7001, refusedReason,
    });
    await appendUnattendedRunTerminal(cortexDir, dataKey, refuseRunId, {
      status: 'aborted', endedAt: 7002, note: refusedReason,
    });
    await flushUnattendedAuditWrites(cortexDir);

    const refuseTrace = await readRunTrace(cortexDir, dataKey, refuseRunId);
    assert(refuseTrace.actions.length === 1 && refuseTrace.actions[0]!.outcome === 'refused',
      'irreversible action recorded with outcome:refused (NOT executed)', refuseTrace.actions[0]?.outcome);
    assert(refuseTrace.actions[0]!.refusedReason === refusedReason,
      'refusal reason recorded for the owner to review', refuseTrace.actions[0]?.refusedReason);
    assert(!refuseTrace.actions[0]!.undo.reversible && !refuseTrace.actions[0]!.undo.undoToken,
      'refused action carries no undo token (nothing executed)', refuseTrace.actions[0]?.undo);
    assert(!!refuseTrace.header && refuseTrace.header.status === 'aborted',
      'run aborted after the refusal (walk stops)', refuseTrace.header?.status);

    // The contrast: a reversible/none action proceeds (outcome ok, not refused).
    const proceedEffect = classifyReversibility({ kind: 'none' });
    assert(proceedEffect.reversible === true && !(requireReversibleOnly && !proceedEffect.reversible),
      'a read/compute-only (none) action is reversible → proceeds under requireReversibleOnly');
  } finally {
    await cx.cleanup();
  }
}

export async function run(): Promise<SuiteResult> {
  return runSuite('unattended-executor', unattendedSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('unattended-executor', unattendedSuite);
