// DEFECT B — COMPILE-TIME guard fixture: NEGATIVE control. Every statement
// below must keep compiling cleanly.
//
// Without this file the guard could "pass" by rejecting everything, which
// would be a broken API rather than a fixed one. `tests/defect-b-proof.ts`
// fails if any error is reported against this file.

import type { GraphnosisHost } from '../src/host.js';

declare const host: GraphnosisHost;

export async function mustCompile(): Promise<void> {
  // 1. A narrow patch — the shape callers should reach for by default.
  await host.setSettings({ agent: { enabled: true } });

  // 2. The function form. `current` here is committed state read INSIDE the
  //    write queue, so spreading it is safe and stays legal.
  await host.setSettings((current) => ({ ...current, agent: { enabled: true } }));

  // 3. The function form doing a genuine read-modify-write.
  await host.setSettings((current) => ({
    agent: { ...(current.agent ?? { enabled: true }), enabled: false },
  }));

  // 4. Reading fields off a snapshot is still fine — reading was never the
  //    bug. Only writing a snapshot back is.
  const current = host.getSettings();
  const enabled: boolean | undefined = current.agent?.enabled;
  void enabled;

  // 5. A snapshot is still assignable to AppSettings, so every existing helper
  //    that takes settings keeps accepting getSettings() unchanged.
  const asSettings: import('@graphnosis-app/core/settings').AppSettings = current;
  void asSettings;

  // 6. The SUBTREE read-modify-write, done correctly: the `ai` subtree is
  //    spread from the callback's COMMITTED read, not from an outer snapshot.
  //    This is the shape every `{ ai: { … } }` call site must now use, and it
  //    must keep compiling — the guard would be useless if it left no legal
  //    way to patch one field of a subtree.
  await host.setSettings((committed) => ({
    ai: { ...committed.ai, llmEnabled: true },
  }));

  // 7. Reading a field off a subtree snapshot is still fine. Only writing the
  //    subtree back is the bug.
  const model: string | undefined = current.ai.llmModel;
  void model;

  // 8. A committed subtree is still assignable to its own type, so every
  //    helper that takes `AiSettings` keeps accepting `getSettings().ai`.
  const asAi: import('@graphnosis-app/core/settings').AiSettings = current.ai;
  void asAi;

  // 9. A caller-BUILT subtree (not spread from a snapshot) is not a stale
  //    snapshot and stays legal — it replaces the subtree wholesale, which is
  //    the pre-existing meaning of a `{ ai: … }` patch.
  await host.setSettings({ ai: { ...asAi } });

  // 10. The opts argument still works alongside a patch.
  await host.setSettings({ agent: { enabled: true } }, { userInitiated: true });
}
