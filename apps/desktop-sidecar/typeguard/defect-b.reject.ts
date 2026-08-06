// DEFECT B — COMPILE-TIME guard fixture: every statement below MUST be a type
// error. `tests/defect-b-proof.ts` compiles this file and fails if any of them
// starts being accepted.
//
// Not part of the sidecar build: it lives outside `src/`, so the app tsconfig
// (`include: ["src/**/*.ts"]`) never sees it. It is compiled only by
// `tsconfig.typeguard.json`.
//
// Nothing here runs. `host` is `declare`d, so this is a pure type assertion.

import type { GraphnosisHost } from '../src/host.js';

declare const host: GraphnosisHost;

export async function mustNotCompile(): Promise<void> {
  const current = host.getSettings();

  // 1. The canonical DEFECT B shape: a whole-tree snapshot spread into a patch.
  //    Every key of `current` wins the shallow merge, reverting anything that
  //    committed after the snapshot was taken.
  await host.setSettings({ ...current, agent: { enabled: true } });

  // 2. Same thing across an await — the actually-dangerous version, where the
  //    snapshot is provably stale by the time it is written back.
  await Promise.resolve();
  await host.setSettings({ ...current, agent: { enabled: false } });

  // 3. Rest-destructuring launders the spread through a new binding. The brand
  //    rides along, so this is caught too.
  const { ai: _ai, ...rest } = current;
  await host.setSettings(rest);

  // 4. Aliasing the snapshot first does not help either.
  const alias = current;
  await host.setSettings({ ...alias, agent: { enabled: true } });

  // 5. Returning a stale snapshot from the FUNCTION form. The callback is
  //    handed committed state; spreading the outer snapshot instead defeats
  //    the point, and the brand catches that too.
  await host.setSettings(() => ({ ...current, agent: { enabled: true } }));

  // ── SUBTREE staleness (the same defect one level down) ──────────────────

  // 6. The dominant shape in this codebase: a narrow-looking top-level patch
  //    whose VALUE was spread from a committed subtree. The shallow merge
  //    replaces the whole committed `ai` with the T0 one, reverting every
  //    sibling field that committed in between.
  await host.setSettings({ ai: { ...current.ai } });

  // 7. The security-relevant instance: a consent list rebuilt from a stale
  //    read. A revoke that commits during the await is silently undone.
  await Promise.resolve();
  await host.setSettings({ ai: { ...current.ai, dataAccessConsents: [] } });

  // 8. Rest-destructuring the SUBTREE launders it through a new binding, but
  //    object rest copies own enumerable symbols, so the brand rides along.
  const { llmModel: _model, ...aiRest } = current.ai;
  await host.setSettings({ ai: aiRest });

  // 9. Aliasing the subtree first does not help either.
  const aiAlias = current.ai;
  await host.setSettings({ ai: { ...aiAlias, llmEnabled: false } });

  // 10. Spreading the OUTER snapshot's subtree from inside the function form
  //     defeats the function form, exactly as case 5 does at the root.
  await host.setSettings(() => ({ ai: { ...current.ai, llmEnabled: false } }));
}
