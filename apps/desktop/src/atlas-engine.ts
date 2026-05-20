// ── Multi-engine Atlas: the swappable rendering layer ──────────────
//
// `AtlasEngine` is the interface every rendering backend implements.
// Four engines target different scale + dimensionality tiers; the user
// picks one in Settings, the factory instantiates it.
//
// See ~/.claude/plans/multi-engine-atlas.md for the full architecture.
//
// Today's current renderer (3d-force-graph wrapper, lives in atlas.ts)
// is Engine "force-3d". Stubs for the other three are wired below but
// not implemented yet — selecting them shows a "Coming soon" placeholder
// in the atlas pane. Each engine will be filled in over coming sessions:
//
//   sigma-2d    : Sigma.js v3 + Graphology — high-scale 2D (next)
//   three-custom: Custom Three.js + InstancedMesh + Worker physics
//   deckgl-2d   : deck.gl + ScatterplotLayer + LineLayer (optional)

import type {
  AtlasNode,
  AtlasDirectedEdge,
  AtlasUndirectedEdge,
  EdgeCategory,
  AtlasOptions,
} from './atlas.js';

// Alias so engine modules can use a shorter name.
export type AtlasOpts = AtlasOptions;

/** Identifier persisted in user settings to pick the active engine. */
export type AtlasEngineKind =
  | 'force-3d'      // Engine #1 — current renderer, 3d-force-graph
  | 'sigma-2d';     // Engine #2 — Sigma.js v3 + Graphology (stub)

export interface EngineDescriptor {
  kind: AtlasEngineKind;
  label: string;
  /** One-line user-facing description for the settings dropdown. */
  description: string;
  /** Dimensionality — affects which interactions / camera controls apply. */
  dimensions: 2 | 3;
  /** When `false`, picking this engine shows a "Coming soon" panel
   *  instead of constructing the renderer. */
  available: boolean;
  /** Order in the settings dropdown. */
  order: number;
}

export const ATLAS_ENGINES: EngineDescriptor[] = [
  {
    kind: 'force-3d',
    label: '3D Force',
    description: 'Three.js + force-directed physics via 3d-force-graph. Good up to ~5K visible nodes.',
    dimensions: 3,
    available: true,
    order: 1,
  },
  {
    kind: 'sigma-2d',
    label: '2D Sigma (high-scale)',
    description: 'WebGL 2D renderer optimized for 100K-500K nodes. Coming soon.',
    dimensions: 2,
    available: false,
    order: 2,
  },
];

/** Source listing for the legend, exposed by every engine. */
export interface SourceInfo {
  key: string;
  label: string;
  color: number;
  nodeCount: number;
  visible: boolean;
}

/** Per-node connection record used by the detail-pane inspector. */
export interface NodeConnection {
  neighborId: string;
  type: string;        // SDK edge type (UndirectedEdgeType | DirectedEdgeType)
  category: EdgeCategory;
  direction: 'out' | 'in' | 'undirected';
  weight: number;
}

/**
 * Common interface every rendering engine must implement. Methods kept
 * intentionally narrow — anything engine-specific (physics tuning, custom
 * shaders, etc.) lives inside the implementation.
 *
 * Optional methods are for capabilities not all engines support. The App
 * checks `typeof engine.X === 'function'` before calling.
 */
export interface AtlasEngine {
  readonly kind: AtlasEngineKind;

  // ── Data ────────────────────────────────────────────────────────
  setNodes(nodes: AtlasNode[]): void;
  setEdges(directed: AtlasDirectedEdge[], undirected: AtlasUndirectedEdge[]): void;
  getNodes(): AtlasNode[];

  // ── Selection / focus ───────────────────────────────────────────
  select(nodeId: string): void;
  focus(nodeId: string): void;
  resetEmphasis(): void;
  previewHighlight?(nodeId: string | null): void;

  // ── Filters ─────────────────────────────────────────────────────
  setCategoryVisible(category: EdgeCategory, visible: boolean): void;
  getCategoryVisibility(): Record<EdgeCategory, boolean>;
  setSourceVisible(sourceKey: string, visible: boolean): void;
  sourcesWithCounts(): SourceInfo[];
  edgeCounts(): Record<EdgeCategory, number>;

  // ── View ────────────────────────────────────────────────────────
  zoomToFit(ms?: number, padding?: number): void;
  pauseAnimation(): void;
  resumeAnimation(): void;

  // ── Motion / liveness (3D engines mostly) ──────────────────────
  setAliveEnabled?(enabled: boolean): boolean;
  isAliveEnabled?(): boolean;
  unpinAll?(): void;
  setBrainVitality?(vitality: number): void;

  // ── Connections (for detail-pane sidebar) ───────────────────────
  getConnections(nodeId: string): NodeConnection[];

  // ── Lifecycle ───────────────────────────────────────────────────
  dispose(): void;

  // ── Perf experimentation (optional) ─────────────────────────────
  reapplyPerfFlags?(): void;

  // ── Diagnostic / support (optional, session-only) ────────────────
  isOrbitDebugHUDVisible?(): boolean;
  startOrbitDebugHUD?(): void;
  stopOrbitDebugHUD?(): void;
}

/** Factory: construct the engine the user has selected.
 *
 *  Unknown / unavailable kinds fall back to `force-3d` rather than
 *  throwing — the user gets the working engine, not a broken pane.
 *  Pass a config diff via `opts` (passed straight through to the
 *  underlying engine's constructor). */

export async function createAtlasEngine(
  kind: AtlasEngineKind,
  opts: AtlasOpts,
): Promise<AtlasEngine> {
  const desc = ATLAS_ENGINES.find((e) => e.kind === kind);
  if (!desc || !desc.available) {
    // Stub fallback — render a "Coming soon" placeholder. Returns an
    // AtlasEngine that no-ops every method except dispose.
    return createStubEngine(kind, opts);
  }

  switch (kind) {
    case 'force-3d': {
      const { Atlas } = await import('./atlas.js');
      // The current Atlas class already matches this interface
      // (verified via the audit above). The `as AtlasEngine` cast is
      // safe — we'll tighten by adding `implements AtlasEngine` to
      // the class next.
      return new Atlas(opts) as unknown as AtlasEngine;
    }
    case 'sigma-2d':
      // Not yet implemented — fall through to stub.
      return createStubEngine(kind, opts);
  }
}

/**
 * Placeholder engine for kinds that aren't built yet. Renders an
 * informational panel into the container. Implements the full
 * AtlasEngine interface as no-ops so the rest of the App doesn't
 * have to check for nulls.
 */
function createStubEngine(kind: AtlasEngineKind, opts: AtlasOpts): AtlasEngine {
  const desc = ATLAS_ENGINES.find((e) => e.kind === kind);
  const labelText = desc?.label ?? kind;
  const description = desc?.description ?? '';

  const container = opts.container;
  container.innerHTML = `
    <div style="
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 24px;
      color: var(--fg-dim, #888);
      font-size: 13px;
      text-align: center;
      pointer-events: none;
    ">
      <div style="font-weight: 600; font-size: 14px; color: var(--fg, #ddd); margin-bottom: 6px;">
        ${escapeHtml(labelText)}
      </div>
      <div style="max-width: 480px; line-height: 1.5; margin-bottom: 14px;">
        ${escapeHtml(description)}
      </div>
      <div style="opacity: 0.6; font-style: italic;">
        Coming in a future release. Switch back to "3D Force (current)" in Settings to render the graph.
      </div>
    </div>
  `;

  const emptyCategoryVisibility: Record<EdgeCategory, boolean> = {
    reasoning: true, structure: true, social: true,
    temporal: true, semantic: true, identity: true,
  };
  const zeroCounts: Record<EdgeCategory, number> = {
    reasoning: 0, structure: 0, social: 0,
    temporal: 0, semantic: 0, identity: 0,
  };

  return {
    kind,
    setNodes: () => {},
    setEdges: () => {},
    getNodes: () => [],
    select: () => {},
    focus: () => {},
    resetEmphasis: () => {},
    setCategoryVisible: () => {},
    getCategoryVisibility: () => ({ ...emptyCategoryVisibility }),
    setSourceVisible: () => {},
    sourcesWithCounts: () => [],
    edgeCounts: () => ({ ...zeroCounts }),
    zoomToFit: () => {},
    pauseAnimation: () => {},
    resumeAnimation: () => {},
    getConnections: () => [],
    dispose: () => { container.innerHTML = ''; },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
