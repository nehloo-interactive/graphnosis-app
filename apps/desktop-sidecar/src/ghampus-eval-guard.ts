/**
 * Cortex write guard for Ghampus eval harness — never mutate production engrams.
 */

export const EVAL_ENGRAM_ALLOWLIST_PREFIXES = [
  'ghampus-tests',
  'ghampus-qa-skills',
  'ghampus-eval-runs',
] as const;

export const DEFAULT_TEST_CORTEX_SUFFIX = 'Graphnosis-test';

export function isAllowlistedEvalGraphId(graphId: string): boolean {
  return EVAL_ENGRAM_ALLOWLIST_PREFIXES.some(
    (p) => graphId === p || graphId.startsWith(`${p}-`) || graphId.startsWith(`${p}_`),
  );
}

export function isDefaultTestCortexPath(cortexDir: string): boolean {
  const base = cortexDir.replace(/\/+$/, '').split('/').pop() ?? '';
  return base === DEFAULT_TEST_CORTEX_SUFFIX || base.endsWith('-test');
}

/** Ephemeral cortex dirs created by the eval harness (isolated sidecar runs). */
export function isIsolatedEvalCortexPath(cortexDir: string): boolean {
  const base = cortexDir.replace(/\/+$/, '').split('/').pop() ?? '';
  return base.startsWith('gn-ghampus-eval-') || base.startsWith('gn-ghampus-verify-');
}

export function shouldForceReadonly(cortexDir: string, envReadonly?: string): boolean {
  if (envReadonly === '1' || envReadonly === 'true') return true;
  if (process.env.GRAPHNOSIS_EVAL_READONLY === '1') return true;
  if (isDefaultTestCortexPath(cortexDir) || isIsolatedEvalCortexPath(cortexDir)) return false;
  return process.env.GRAPHNOSIS_EVAL_ALLOW_PROD_WRITES !== '1';
}

export class EvalWriteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalWriteGuardError';
  }
}

export function assertEvalWriteAllowed(
  graphId: string,
  cortexDir: string,
  snapshotGraphIds: Set<string>,
): void {
  if (shouldForceReadonly(cortexDir)) {
    throw new EvalWriteGuardError(
      `Eval write blocked: cortex ${cortexDir} is read-only (set GRAPHNOSIS_EVAL_READONLY=0 on test cortex only).`,
    );
  }
  if (!isAllowlistedEvalGraphId(graphId)) {
    throw new EvalWriteGuardError(
      `Eval write blocked: graphId "${graphId}" is not on the allowlist (${EVAL_ENGRAM_ALLOWLIST_PREFIXES.join(', ')}*).`,
    );
  }
  if (snapshotGraphIds.has(graphId) && !isAllowlistedEvalGraphId(graphId)) {
    throw new EvalWriteGuardError(
      `Eval write blocked: pre-existing graphId "${graphId}" is not allowlisted.`,
    );
  }
}
