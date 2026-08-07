import {
  resolveClassificationPolicy,
  sanitizeClassificationSchema,
  DEFAULT_CLASSIFICATION_LABELS,
} from '@graphnosis-app/core';
import { assert, section, runSuite, type SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('classification-schema', classificationSchemaSuite);
}

async function classificationSchemaSuite(): Promise<void> {
  section('sanitize + resolve red → sensitive');
  const schema = sanitizeClassificationSchema({
    enabled: true,
    labels: DEFAULT_CLASSIFICATION_LABELS.map((l) =>
      l.id === 'red' ? { ...l, capOverrides: { maxTokens: 500, maxNodes: 5 } } : l,
    ),
  });
  assert(schema?.enabled === true, 'schema enabled');
  const policy = resolveClassificationPolicy('red', schema, undefined);
  assert(policy.tier === 'sensitive', 'red maps to sensitive', { tier: policy.tier });
  assert(policy.caps.maxTokens === 500 && policy.caps.maxNodes === 5, 'red cap overrides', policy.caps);

  section('disabled label ignored');
  const disabled = sanitizeClassificationSchema({
    enabled: true,
    labels: [{ ...DEFAULT_CLASSIFICATION_LABELS[2]!, enabled: false }],
  });
  const fallback = resolveClassificationPolicy('red', disabled, { sensitivityTier: 'personal', template: 'personal', displayName: 'x', createdAt: 0 });
  assert(fallback.tier === 'personal', 'disabled label falls back to metadata tier', { tier: fallback.tier });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((r) => process.exit(r.failed > 0 ? 1 : 0));
}
