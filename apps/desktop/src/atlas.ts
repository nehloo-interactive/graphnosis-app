/**
 * Atlas — 3D force-directed visualization of a Graphnosis engram.
 *
 * Naming note for future me / future you: the user-facing label of this
 * view in the App rail is **"Graphnosis"**, matching the product name.
 * Internally we keep the symbol `Atlas` because (a) the product, the SDK
 * (`@nehloo/graphnosis`), and IPC namespace already own the word
 * "graphnosis", and (b) "Atlas" describes what this component *is* — a
 * navigable spatial map — which pairs nicely with the brain metaphor
 * (cortex atlas of memory regions). The two stay separate by design so
 * the UI label can change without renaming files.
 *
 * Rendering + physics + interaction is delegated to `3d-force-graph`
 * (a thin, well-maintained Three.js wrapper). We keep our own state for
 * filters (edge categories + sources) and provide a stable public API
 * (`setNodes`, `setEdges`, `focus`, `getConnections`, etc.) so the rest of
 * the App barely changes when we tune the renderer.
 *
 * Why this library and not raw Three.js:
 *  - Battle-tested drag-and-pin behavior (set fx/fy/fz on drag end).
 *  - Built-in arrowheads on directional links, sized per-link by callback.
 *  - Trackball controls = cursor-aware zoom and pan out of the box.
 *  - Smooth easing + cooldown semantics for the physics simulation —
 *    nodes drift instead of snapping, which is what "feels alive" means
 *    when you watch the graph settle.
 */

import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
// 3d-force-graph uses d3-force-3d internally but doesn't add a collision
// force by default — we add one ourselves to give every node a "personal
// bubble" so dense clusters can't visually overlap. d3-force-3d ships
// untyped; the API is a near-1:1 of d3-force in 3D.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no types ship with d3-force-3d.
import { forceCollide } from 'd3-force-3d';

export interface AtlasNode {
  id: string;
  text: string;
  sourceFile?: string;
  /** Allowlist sourceId (server-resolved). Carried for Presentation Mode
   *  per-source label masking; not used by the force simulation. */
  sourceId?: string;
  confidence: number;
  // 3d-force-graph mutates these during simulation. Optional on input.
  x?: number; y?: number; z?: number;
  // User can pin a node by dragging — these get set in onNodeDragEnd.
  fx?: number; fy?: number; fz?: number;
}

export type DirectedEdgeType =
  | 'causes' | 'depends-on' | 'precedes' | 'contains' | 'defines' | 'cites'
  | 'contradicts' | 'supports' | 'supersedes' | 'discussed-in' | 'knows'
  | 'works-with' | 'reports-to' | 'collaborated-on' | 'prefers' | 'summarizes';
export type UndirectedEdgeType =
  | 'similar-to' | 'co-occurs' | 'shares-entity' | 'shares-topic'
  | 'same-source' | 'same-person' | 'related-to';

export interface AtlasDirectedEdge {
  id: string;
  from: string;
  to: string;
  type: DirectedEdgeType;
  weight: number;
  /** User-chosen human label for typed edges created via the App's
   *  relationship picker (e.g. "Works at" backing a `collaborated-on`).
   *  Auto-extracted edges leave this empty. The 3D viz renders edges
   *  by type/category — evidence is metadata for the detail pane only. */
  evidence?: string;
}
export interface AtlasUndirectedEdge { id: string; a: string; b: string; type: UndirectedEdgeType; weight: number; }

/**
 * A Graphnosis Neural Network prediction — a connection the model believes
 * is likely real. Rendered as a distinct, dashed, toggleable overlay layer
 * in the atlas; it is NOT an edge in the deterministic `.gai` graph and
 * lives only in the encrypted `.gnn` overlay.
 */
export interface AtlasPredictedEdge { id: string; from: string; to: string; score: number; }

export type EdgeCategory = 'reasoning' | 'structure' | 'social' | 'temporal' | 'semantic' | 'identity' | 'predicted';

const DIRECTED_CATEGORY: Record<DirectedEdgeType, EdgeCategory> = {
  causes: 'reasoning', supports: 'reasoning', contradicts: 'reasoning', supersedes: 'reasoning',
  contains: 'structure', defines: 'structure', cites: 'structure', summarizes: 'structure',
  knows: 'social', 'works-with': 'social', 'reports-to': 'social',
  'collaborated-on': 'social', prefers: 'social', 'discussed-in': 'social',
  'depends-on': 'temporal', precedes: 'temporal',
};
const UNDIRECTED_CATEGORY: Record<UndirectedEdgeType, EdgeCategory> = {
  'similar-to': 'semantic', 'co-occurs': 'semantic', 'shares-topic': 'semantic',
  'shares-entity': 'semantic', 'related-to': 'semantic',
  'same-source': 'identity', 'same-person': 'identity',
};

export const CATEGORY_COLOR: Record<EdgeCategory, number> = {
  reasoning: 0xfb7185,
  structure: 0x60a5fa,
  social:    0xa3e635, // lime — swapped from predicted (was 0xc084fc)
  temporal:  0xfbbf24,
  semantic:  0x6ab3c8,
  identity:  0x9a9a9c,
  predicted: 0xc084fc, // purple — matches GNN branding (was 0xa3e635)
};

/**
 * Per-evidence color overrides. Take precedence over CATEGORY_COLOR for edges
 * whose evidence string matches a key here. Used to visually separate semantically
 * distinct uses of the same SDK edge type — e.g. `skill:goal` and `skill:calls`
 * both use the `contains` directed type (→ blue) but mean very different things,
 * so `skill:goal` gets emerald and `skill:calls` keeps the structure blue.
 *
 * Lookup is `evidence?.split(';')[0]` so structured-call evidences like
 * `skill:calls;capture=foo` still match the base `skill:calls` key.
 */
export const EVIDENCE_COLOR_OVERRIDE: Record<string, number> = {
  'skill:goal': 0x10b981, // emerald — skill goals (constraints / Requires / Produces)
};

/** Optional human label shown in the legend when an evidence-override edge
 *  is present in the visible engram. */
export const EVIDENCE_OVERRIDE_LABEL: Record<string, string> = {
  'skill:goal': 'Skill goals',
};
export const CATEGORY_LABEL: Record<EdgeCategory, string> = {
  reasoning: 'Reasoning',
  structure: 'Structure',
  social:    'Social',
  temporal:  'Temporal',
  semantic:  'Semantic',
  identity:  'Identity',
  predicted: 'Predicted',
};
export function categoryFor(directed: boolean, type: DirectedEdgeType | UndirectedEdgeType): EdgeCategory {
  if (directed) return DIRECTED_CATEGORY[type as DirectedEdgeType];
  return UNDIRECTED_CATEGORY[type as UndirectedEdgeType];
}

/** Smoothness of the dashed Bezier drawn for a curved predicted edge. */
const PREDICTED_CURVE_SEGMENTS = 20;
/** Scratch vector reused by positionDashedLink's curve sampling. */
const _predictedCurvePoint = new THREE.Vector3();

/**
 * Build the dashed THREE.Line used to render one GNN-predicted edge.
 * Predicted edges are deliberately thin 1px dashed lines so they read as
 * tentative against the solid weighted tubes of real connections.
 */
function makeDashedLink(): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  // Sized for the curved case; a straight predicted edge uses only the first
  // two vertices via setDrawRange (see positionDashedLink).
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((PREDICTED_CURVE_SEGMENTS + 1) * 3), 3));
  geometry.setDrawRange(0, 2);
  const material = new THREE.LineDashedMaterial({
    color: CATEGORY_COLOR.predicted,
    dashSize: 9,
    gapSize: 6,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 2;
  // The prediction overlay is decorative — never a raycast / hover target.
  line.raycast = () => {};
  return line;
}

/**
 * Position a predicted-edge dashed line. Straight by default; when the edge
 * shares a node pair with a directed edge it carries a curvature (assigned in
 * computeEdgeShapes) and is drawn as a quadratic Bezier so the dashed arc
 * bows clear of the straight directed line — the same control-point math
 * three-forcegraph applies to its real co-parallel edges. Runs every physics
 * tick while the simulation is warm; LineDashedMaterial needs
 * computeLineDistances() recomputed after a move.
 */
function positionDashedLink(
  obj: THREE.Object3D,
  coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
  shape: { curvature: number; rotation: number } | undefined,
): void {
  const line = obj as THREE.Line;
  const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  const { start, end } = coords;

  if (shape === undefined || shape.curvature === 0 || !globalThis.atlasPerf.curves) {
    // Straight: two vertices, the rest of the buffer left unused.
    pos.setXYZ(0, start.x, start.y, start.z);
    pos.setXYZ(1, end.x, end.y, end.z);
    line.geometry.setDrawRange(0, 2);
  } else {
    // Curved: control point computed exactly as three-forcegraph does for
    // real curved edges, so a predicted arc and its directed partner
    // separate identically.
    const vStart = new THREE.Vector3(start.x, start.y, start.z);
    const vEnd = new THREE.Vector3(end.x, end.y, end.z);
    const vLine = new THREE.Vector3().subVectors(vEnd, vStart);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const cp = vLine.clone()
      .multiplyScalar(shape.curvature)
      .cross(dx !== 0 || dy !== 0 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0))
      .applyAxisAngle(vLine.normalize(), shape.rotation)
      .add(new THREE.Vector3().addVectors(vStart, vEnd).divideScalar(2));
    const curve = new THREE.QuadraticBezierCurve3(vStart, cp, vEnd);
    for (let i = 0; i <= PREDICTED_CURVE_SEGMENTS; i++) {
      const p = curve.getPoint(i / PREDICTED_CURVE_SEGMENTS, _predictedCurvePoint);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    line.geometry.setDrawRange(0, PREDICTED_CURVE_SEGMENTS + 1);
  }
  pos.needsUpdate = true;
  line.computeLineDistances();
}

// How long after a mousemove on the canvas we suppress the periodic
// reheat. Long enough that normal cursor hovering doesn't constantly
// restart physics (which would fight the breathing / jelly effects).
const SUPPRESS_AFTER_MOVE_MS = 5_000;
// Edge count above which a category is permanently hard-locked:
// never rendered, never toggled on, hover skipped entirely.
// Below this the auto-hide tier still applies (e.g. semantic > 5 K is
// hidden by default but the user can re-enable it up to this ceiling).
const EDGE_HARD_LOCK_THRESHOLD = 10_000;

/** Render at most this many edges of any single category. Dense categories
 *  (e.g. semantic) are SAMPLED down to this (strongest by weight) rather than
 *  hard-hidden — the graph stays "wired" without a 50k-edge hairball or cost. */
const EDGE_SAMPLE_CAP = 5_000;

/** How long to keep existing nodes pinned after an incremental (ingest) add,
 *  giving the new source's nodes time to settle before the whole graph is
 *  freed again. */
const INCREMENTAL_UNPIN_MS = 2_500;
// How long after an empty-canvas click. Much longer — clicking empty
// space is a deliberate "stop" gesture, the user wants stillness.
const SUPPRESS_AFTER_CLICK_MS = 30_000;

// ── Perf A/B harness ───────────────────────────────────────────────
//
// Runtime-togglable flags for every visual "beautification" the Atlas
// applies. Each flag defaults to `true` (current behavior). To find the
// per-feature CPU cost, flip them off one at a time from the DevTools
// console:
//
//   atlasPerf.particles = false; atlasPerfApply()
//   atlasPerf.reheat = false;    atlasPerfApply()
//   atlasPerf.curves = false;    atlasPerfApply()
//   atlasPerf.collide = false;   atlasPerfApply()
//   atlasPerf.dim = false;       atlasPerfApply()
//   atlasPerf.arrows = false;    atlasPerfApply()
//
// Reset: Object.keys(atlasPerf).forEach(k => atlasPerf[k] = true); atlasPerfApply()
//
// The flags are a global object (declared in main.ts) so the user can
// inspect / mutate from DevTools without rebuilding. `atlasPerfApply()`
// re-applies them to the live Atlas instance.

export interface AtlasPerfFlags {
  /** Flowing pulse particles on directional edges. Expensive — each
   *  particle is a sprite material updated per frame. */
  particles: boolean;
  /** Periodic reheat that keeps physics alive at 4s/10s/20s cadence.
   *  Disable to let the simulation cool fully after each kick. */
  reheat: boolean;
  /** Curvature on multi-edges. Setting false makes every edge a
   *  straight line — drops per-edge Bezier math. */
  curves: boolean;
  /** D3 collide force (radius-based separation). O(N²) worst case;
   *  the heaviest per-tick force on large graphs. */
  collide: boolean;
  /** Per-node color dimming when a node is selected. Already cached;
   *  flag exists for completeness. */
  dim: boolean;
  /** Directional arrowheads at the end of directed edges. Sprite-based;
   *  light-weight but worth measuring. */
  arrows: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var atlasPerf: AtlasPerfFlags;
  // eslint-disable-next-line no-var
  var atlasPerfApply: () => void;
}

if (typeof globalThis.atlasPerf === 'undefined') {
  globalThis.atlasPerf = {
    particles: true,
    reheat: true,
    curves: true,
    collide: true,
    dim: true,
    arrows: true,
  };
}

// 10-color palette per source (stable hash → palette index).
const SOURCE_PALETTE = [
  0x6ab3c8, 0xa855f7, 0x4ade80, 0xf472b6, 0xfbbf24,
  0x60a5fa, 0xfb7185, 0x34d399, 0xc084fc, 0xfcd34d,
];
function colorForSource(source: string | undefined): number {
  if (!source) return 0x9a9a9c;
  let hash = 5381;
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return SOURCE_PALETTE[Math.abs(hash) % SOURCE_PALETTE.length] ?? 0x9a9a9c;
}

/**
 * Deterministic hash of a string → float in [0, 1).
 * Used to derive per-source anisotropy values that are stable across reloads.
 * `seed` lets us get multiple independent values from the same string.
 */
function hashStrToFloat(s: string, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  h = h ^ (h >>> 16);
  h = Math.imul(h, 0x45d9f3b) | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 0xffffffff;
}

/**
 * i-th point on a Fibonacci sphere with n total points.
 * Returns a unit vector [x, y, z].  Points are uniformly distributed on
 * the sphere surface — perfect for spreading nodes evenly before applying
 * per-source anisotropic deformation.
 */
function fibonacciSpherePoint(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5)); // golden angle ≈ 2.399 rad
  const y = 1 - (i / Math.max(n - 1, 1)) * 2;  // latitude: 1 → -1
  const r = Math.sqrt(1 - y * y);
  const theta = golden * i;
  return [Math.cos(theta) * r, y, Math.sin(theta) * r];
}

/**
 * Human-readable label for a source key shown in the atlas legend.
 *
 *  clip:{timestamp}:{title}  →  "AI · {title}"   (AI memory ingested via Claude)
 *  clip:{timestamp}          →  "AI memory"       (no title recorded)
 *  /path/to/file.md          →  "file.md"         (basename only)
 *  anything else             →  as-is
 */
function labelForSourceKey(key: string): string {
  // Clip refs: clip:{unix_ms_or_id}:{optional title}
  const clipMatch = key.match(/^clip:[^:]+:(.+)$/);
  if (clipMatch?.[1]) return `AI·${clipMatch[1]}`;
  if (/^clip:/.test(key)) return 'AI memory';
  // File path — show only the filename
  if (key.includes('/')) return key.split('/').pop() ?? key;
  return key;
}

/** Internal link shape — 3d-force-graph wants a flat {source, target} list. */
interface AtlasLink {
  id: string;
  source: string; // node id (becomes node ref after simulation init)
  target: string;
  directed: boolean;
  type: DirectedEdgeType | UndirectedEdgeType;
  category: EdgeCategory;
  weight: number;
  /** Carried from AtlasDirectedEdge — drives per-evidence color overrides
   *  (e.g. `skill:goal` → emerald). Only set for directed edges. */
  evidence?: string;
}

export interface AtlasOptions {
  container: HTMLElement;
  onSelect?: (node: AtlasNode | null) => void;
  /** Smaller renderer for the embedded Overview mini-Atlas. */
  compact?: boolean;
}

export class Atlas {
  private graph: ForceGraph3DInstance;
  private allNodes: AtlasNode[] = [];

  // ── Instanced node layer (THREE.Points) — task #42 ────────────────────────
  // One GPU draw call for all nodes, replacing the ~2N per-node THREE objects
  // (default sphere + invisible hit sphere) that tank browsing on large graphs.
  // STAGE A: renders ALONGSIDE the library spheres to validate position/colour/
  // size sync; later stages disable the spheres and move picking/drag onto this.
  private nodePoints: THREE.Points | null = null;
  private nodePointsGeom: THREE.BufferGeometry | null = null;
  /** node id -> buffer index, rebuilt on setNodes. */
  private nodePointIndex = new Map<string, number>();
  /** Off by default until Stage B/C/D land (sphere removal + picking/drag on
   *  the Points layer). While off, the atlas renders exactly as before; the
   *  Stage-A infrastructure is dormant. Flip true to preview the additive
   *  Points overlay. */
  private nodePointsEnabled = false;
  private allLinks: AtlasLink[] = [];

  /** Return current x/y/z for every already-positioned node. Used by
   *  pushDataIntoAtlas() in main.ts to carry positions forward across
   *  incremental refreshes so nodes don't re-seed from the cluster center
   *  on every MCP ingest event. */
  getPositionMap(): Map<string, { x: number; y: number; z: number }> {
    const map = new Map<string, { x: number; y: number; z: number }>();
    for (const n of this.allNodes) {
      if (n.x !== undefined && n.y !== undefined && n.z !== undefined) {
        map.set(n.id, { x: n.x, y: n.y, z: n.z });
      }
    }
    return map;
  }
  /** SDK edges (the deterministic `.gai` graph) — the real connections. */
  private realLinks: AtlasLink[] = [];
  /** GNN-predicted edges (the `.gnn` overlay) — a separate, dashed,
   *  toggleable layer, never mixed into the deterministic graph. */
  private predictedLinks: AtlasLink[] = [];
  /** THREE.Line objects for the predicted overlay, keyed by AtlasLink id —
   *  captured in `linkThreeObject` so a connection-row hover can dim/brighten
   *  one specific dashed predicted edge. Its color lives in its own material,
   *  outside the `linkColor` accessor path the real edges use. */
  private predictedLineObjs = new Map<string, THREE.Line>();
  private categoryVisible: Record<EdgeCategory, boolean> = {
    reasoning: true, structure: true, social: true, temporal: true, semantic: true, identity: true,
    // Predicted edges (GNN overlay) are hidden by default. They're a
    // probabilistic OVERLAY on top of the deterministic graph — surfacing
    // them on by default would mix two visually-indistinguishable signal
    // classes (real edges + predictions) and clutter the view. Users who
    // want to see them toggle the "Predicted" category in the legend.
    // This is distinct from the auto-hide threshold (>5K semantic edges
    // gets hidden but can be re-enabled by toggle) — predicted is a
    // qualitative class decision, always-hidden by default regardless of
    // count.
    predicted: false,
  };
  /** Per-category edge counts, refreshed in setEdges. Used by isCategoryHardLocked(). */
  private categoryEdgeCounts = new Map<EdgeCategory, number>();
  /** Categories whose edges were sampled down to EDGE_SAMPLE_CAP this rebuild. */
  private sampledCategories = new Set<EdgeCategory>();
  /** Source visibility — keyed by sourceFile (or empty string for "no source"). */
  private sourceVisible = new Map<string, boolean>();
  /**
   * Per-link curvature + rotation around the source-target axis. Computed
   * after every setEdges so that edges between the same pair of nodes fan
   * out in 3D instead of stacking into a single visually-indistinguishable
   * line. Single edges still get a small baseline curve so the whole graph
   * has the organic neural-network feel.
   */
  private edgeShape = new Map<string, { curvature: number; rotation: number }>();
  /**
   * Weighted degree per node — sum of incident edge weights. Drives node
   * size so hub memories (cross-referenced by many other memories) read as
   * visually heavier than orphans. Computed once per setEdges; cheap to
   * re-read in the nodeVal accessor.
   */
  private nodeDegree = new Map<string, number>();
  /** Currently-selected node id, for emphasis on neighbor hop-walks. */
  private selectedId: string | null = null;
  /**
   * Transient hover-preview node id, set by the inspector when the user
   * hovers a connection row. Distinct from `selectedId`: doesn't move the
   * camera, doesn't replace the click target — just temporarily highlights
   * the node + its incident edges until the mouse moves away.
   */
  private previewHighlightId: string | null = null;
  /**
   * The node the inspector's connection list is built around — supplied by
   * `previewHighlight()` so a connection-row hover can light up the edge even
   * when the user never click-selected a node in the 3D view (`selectedId`
   * is null). Falls back to `selectedId` when not given.
   */
  private previewAnchorId: string | null = null;
  /**
   * Legend hover preview — ephemeral, cleared on mouseleave.
   * When either is non-null the visibility callbacks expose ALL nodes/links
   * (overriding category+source filters) and the color callbacks handle
   * dim/bright so the hovered group pops and everything else fades.
   */
  private previewLegendCategory: EdgeCategory | null = null;
  private previewLegendSource: string | null = null;
  /** Cached set: node ids that have at least one link in the previewed category. */
  private previewCatNodeIds = new Set<string>();
  /**
   * Guards a single pending `graph.refresh()` scheduled via rAF.
   * Rapid mouseenter/mouseleave (e.g. Cmd+Tab while over the legend) can
   * fire hover callbacks several times per frame. Without this guard each
   * call clears all color caches and triggers a full re-evaluation of every
   * node/link callback — with 65K+ edges that blocks the main thread.
   * `scheduleRefresh()` coalesces any burst into one rAF tick.
   */
  private pendingRefresh = false;
  /**
   * Node currently being dragged. Used to:
   *   - Boost its size + brightness for visual feedback ("you're holding this one").
   *   - Amplify incident edge forces so the graph elastically follows.
   *   - Pin the node where the user drops it (set in onNodeDragEnd).
   */
  private draggingId: string | null = null;
  /**
   * True for ~1.5s after a node drag ends. During this window the link
   * springs stay active so displaced nodes snap back toward each other
   * (elastic rebound) before the cluster force fully reasserts blob shape.
   */
  private elasticPhase = false;
  private elasticTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Multiplier that scales link distances and charge strength based on
   * how many nodes the graph holds. Recomputed in setNodes. Default 1 for
   * tiny graphs; grows with sqrt(N) so the layout breathes proportionally
   * as the engram fills up — dense clusters don't end up jammed into a
   * pixel-thick mass.
   */
  private layoutScale = 1;
  /** Stored reference to the d3 link force so we can re-trigger strength
   *  re-evaluation at drag start / end / elastic-phase transitions.
   *  d3-force caches per-link strengths at initialization time — calling
   *  `.strength(fn)` again is the only way to force a re-evaluation. */
  private linkForce: {
    strength?: (fn: (l: AtlasLink) => number) => unknown;
  } | null = null;
  /**
   * Periodic gentle reheat — keeps the simulation from fully cooling so
   * the user sees constant drift / inertia. Set in configureRenderer for
   * the main (non-compact) renderer only; the Overview mini-atlas does
   * NOT use this so it doesn't burn CPU sitting idle on the dashboard.
   */
  private reheatInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * True while the user is actively orbiting the camera (mouse-drag on
   * empty canvas). Pauses the periodic reheat so nodes stop drifting
   * underneath the user's spin — a moving graph + moving camera together
   * causes motion sickness. Cleared when the controls' 'end' event fires.
   */
  private isOrbiting = false;
  /** Cursor position (client coords) at the most recent pointerdown — used
   *  to project the orbit pivot into world space when rotation starts. */
  private lastPointerDown: { x: number; y: number } = { x: 0, y: 0 };
  /**
   * Timestamp of the last TrackballControls 'end' event (pointer released).
   * The cosmos idle loop waits ORBIT_COOLDOWN_MS after this before starting
   * its camera oscillation, giving TC's built-in damping time to settle.
   */
  private lastOrbitEndMs = 0;
  /**
   * Last time the user moved the mouse over the canvas. Any mousemove
   * (no matter how slow) suppresses the periodic reheat for SUPPRESS_AFTER_MOVE_MS.
   * Reading: "the user is targeting something — don't shift the floor."
   */
  private lastMouseMove = 0;
  /**
   * Last time the user clicked empty canvas space. A deliberate "stop the
   * motion" gesture. Suppresses the periodic reheat for the much longer
   * SUPPRESS_AFTER_CLICK_MS so the user can take their time selecting
   * nodes without the graph wandering underneath their cursor.
   */
  private lastEmptyClick = 0;
  /**
   * Hard kill-switch for the periodic reheat. The mousemove + empty-click
   * suppressors above are TEMPORARY (the simulation drift resumes after
   * the timeout). This flag is the permanent off-switch the user controls
   * from the toolbar — when false the reheat loop skips its tick entirely
   * regardless of any other state. Defaults to true.
   */
  /** Whether to periodically reheat the physics simulation so the graph
   *  "breathes" instead of sitting static. Defaults to FALSE: the reheat
   *  loop is the single biggest source of perf drain on large graphs.
   *  Can be re-enabled per session via the toolbar Motion toggle or
   *  programmatically via setAliveEnabled(). */
  private aliveEnabled = true;

  /**
   * RAF handle for the animated blob explosion. Stored so dispose() can
   * cancel it and so a second call doesn't start two animations.
   */
  private blobAnimRAF: number | null = null;
  /** RAF handle for the XYZ axes indicator in the bottom-right corner. */
  private axesRAF: number | null = null;
  private axesEl: HTMLDivElement | null = null;
  /** Debug HUD overlay — visible during orbit to surface glitch conditions. */
  private dbgEl: HTMLDivElement | null = null;
  private dbgPrevCamPos: THREE.Vector3 | null = null;
  private dbgRAF: number | null = null;
  /** Sticky records for JUMP and NEAR POLE — hold worst value until HUD is clicked. */
  private dbgLastJump:   { delta: number; snapshot: string; at: number } | null = null;
  private dbgLastPole:   { phi: number;   snapshot: string; at: number } | null = null;
  /**
   * Zoom pivot locked for the current RAF frame so multiple scroll events
   * in the same frame all converge on the same world-space point.
   * Released at the start of the next frame via a one-shot RAF callback.
   */
  private zoomPivotLocked: THREE.Vector3 | null = null;
  /**
   * Accumulated zoom factor used within the current RAF frame.  Capped at
   * ±MAX_FRAME_FACTOR so many rapid scroll events don't add up to a huge
   * single-frame movement even when fwdDist is large.
   */
  private zoomFrameAccum = 0;
  /** RAF id for the cosmos idle-oscillation loop; null when not running. */
  private cosmosLoopId: number | null = null;

  // ── BEGIN: grab-to-rotate-pivot (cut this whole block to revert) ──────────
  /** World-space pivot point captured at the moment a drag-rotate begins.
   *  Computed via computeCursorPivot from the cursor's screen position. */
  private grabPivot: THREE.Vector3 | null = null;
  /** Most recent pointer screen coordinates during a grab-rotate (for delta). */
  private grabLastX = 0;
  private grabLastY = 0;
  /** Pointer-down screen coordinates — used for the drag-threshold test
   *  so a quick click still propagates to TC for normal node selection. */
  private grabStartX = 0;
  private grabStartY = 0;
  /** True once the user has dragged past the threshold; false during the
   *  pending pre-threshold period (still might end up being a click). */
  private grabActive = false;
  /** Pointer ID we're tracking — ensures move/up handlers ignore other pointers. */
  private grabPendingPointerId: number | null = null;
  // ── END: grab-to-rotate-pivot ─────────────────────────────────────────────
  /**
   * Per-node jelly velocity (units/ms). Applied directly to node positions in
   * the cosmos RAF, independent of the d3 simulation tick cycle.  This ensures
   * the elastic wobble is visible even when d3 is sleeping between reheats.
   */
  private jellyVelocities = new Map<string, { vx: number; vy: number; vz: number }>();
  /** Pending release of incremental-add pins (see setNodes pinExisting). */
  private incrementalUnpinTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per-node pulsation state for "Living Brain" size animation.
   * Each node oscillates between 1× and 2× its normal size with a random
   * period and phase so nodes are never all at the same scale simultaneously.
   * Updated in cosmos tick; applied directly to node.__threeObj.scale.
   */
  private nodePulsePhase = new Map<string, number>();   // [0, 2π]
  private nodePulsePeriod = new Map<string, number>();  // ms per full cycle [2000, 5000]
  private brainVitality = 50; // 0-100; scales pulsation amp, breath, and reheat intensity
  /**
   * Per-source-file cluster anchor positions. Set by setNodes() whenever
   * source files change. The clusterForce closure reads from this map at
   * every simulation tick, so updates are picked up automatically.
   */
  private clusterCenters = new Map<string, { x: number; y: number; z: number }>();
  /**
   * Per-node target positions within the cluster volume. Each node gets a
   * unique point on an anisotropically-deformed Fibonacci sphere around its
   * cluster center, so the cluster explodes into an organic constellation
   * shape instead of a uniform ball.  Rebuilt in setNodes() alongside
   * clusterCenters; the cluster force lerps toward these over 4 seconds.
   */
  private nodeSubAnchors = new Map<string, { x: number; y: number; z: number }>();
  /**
   * Additive world-space offset applied to every node's cluster-force pull
   * target while a node is being dragged. Keyed by sourceFile. Non-zero only
   * during an active drag; cleared immediately in onNodeDragEnd so the blob
   * springs back elastically via the link force. The cluster force adds this
   * offset on top of the normal sub-anchor target each tick.
   */
  private clusterDragOffset = new Map<string, { x: number; y: number; z: number }>();
  /**
   * Timestamp when the last setNodes() ran. The cluster force uses
   * Date.now() - explosionStartTime to animate a cubic-ease-out spread
   * from cluster center → per-node sub-anchor over EXPLOSION_MS ms.
   */
  private explosionStartTime = 0;
  /**
   * Camera distance from the orbit target, updated by the controls
   * 'change' listener. Used for LOD opacity on cross-cluster semantic
   * edges: far = very faint (noise reduction), close = full opacity
   * (detail visible as the user flies into a cluster).
   * Starts at Infinity so the first render before any camera move
   * treats the view as "far" and applies maximum suppression.
   */
  private lodCamDist = Infinity;
  /** Debounce timer for LOD camera-change → color refresh. */
  private lodRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** O(1) sourceFile lookup per node ID — rebuilt in setNodes(). Used by
   *  the link color callback to detect cross-file edges without iterating
   *  allNodes inside a per-frame hot path. */
  private nodeSourceFileMap = new Map<string, string>();
  /**
   * Precomputed sets of IDs that pass the current source + category filters.
   * Updated by computeVisibility() and read by the nodeVisibility /
   * linkVisibility callbacks registered on the graph. Keeping them as
   * pre-computed sets (O(1) lookup) avoids iterating allLinks inside a
   * per-node render callback.
   */
  private visibleNodeIds = new Set<string>();
  private visibleLinkIds = new Set<string>();
  /** Keyboard listeners that swap the left mouse button's action between rotate (default) and pan (Ctrl/Cmd held). Stored so dispose() can remove them. */
  private onModKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onModKeyUp: ((e: KeyboardEvent) => void) | null = null;
  private resizeObs: ResizeObserver | null = null;

  constructor(private readonly opts: AtlasOptions) {
    // Construct + mount. The library is a `new`-constructor that takes the
    // host element and an optional config object. Trackball controls give
    // the cursor-aware zoom + rotate the user asked for; we can swap to
    // 'orbit' if a power-user wants the centered-rotation behavior back.
    this.graph = new ForceGraph3D(opts.container, {
      controlType: opts.compact ? 'orbit' : 'trackball',
    });
    this.configureRenderer();
    this.wireEvents();
    if (!opts.compact) {
      this.setupAxesIndicator();
      // Debug HUD is hidden by default — enable via Settings → Support.
      // this.startOrbitDebugHUD();
      // Start the idle cosmos rotation so the graph breathes from the moment
      // it appears — no orbit needed to trigger the first spin.
      this.startCosmosLoop();
    }

    // Apply initial size on the next animation frame — if the Atlas pane
    // was mounted via display:none → display:block, layout hasn't settled
    // yet and `clientWidth/Height` read as 0 at construction time.
    requestAnimationFrame(() => this.applySize());

    // Track future resizes (window resize, splitter drags, etc.).
    this.resizeObs = new ResizeObserver(() => this.applySize());
    this.resizeObs.observe(opts.container);
  }

  private configureRenderer(): void {
    const g = this.graph;
    g.backgroundColor('rgba(0,0,0,0)');
    g.showNavInfo(false);

    // Nodes: spheres sized + colored by source. Emphasis driven via
    // `nodeOpacity` (global) plus a per-node opacity-via-color factor when
    // the user selects a neighbor.
    g.nodeRelSize(49.5);
    // Node size combines two signals:
    //   1. Intrinsic confidence (the SDK's notion of "this memory is solid").
    //   2. Weighted degree — sum of incident edge weights. Hub memories
    //      that connect to many others read as visibly heavier than
    //      orphans. Uses sqrt to keep the most-connected node from
    //      dominating the entire scene.
    // Previewed nodes still get a 70% boost so hover stands out.
    g.nodeVal((n: AtlasNode) => {
      const confidencePart = 0.6 + n.confidence * 1.2;
      const degree = this.nodeDegree.get(n.id) ?? 0;
      const degreePart = Math.sqrt(degree) * 0.55;
      let base = confidencePart + degreePart;
      // Visual feedback boosts (stackable, clamped by return value being ∛'d).
      if (n.id === this.selectedId)          base *= 2.5; // selected → notably larger
      if (this.previewHighlightId === n.id)  base *= 1.7;
      if (this.draggingId === n.id)          base *= 1.5;
      return base;
    });
    // Larger invisible hit sphere on top of the visible node sphere.
    // The default sphere's radius = nodeRelSize × ∛(nodeVal) which at
    // the base confidence (0.9) / zero-degree is roughly 3.2 × ∛(1.7) ≈
    // 3.9 units — comfortable visually but hard to hit in 3D.
    // We add a transparent sphere 3× larger so the user can click/hover
    // from a wider angle without needing pixel-perfect aim.
    // `nodeThreeObjectExtend(true)` keeps the original coloured sphere;
    // we only add the invisible hit mesh as a sibling in the group.
    g.nodeThreeObjectExtend(true);
    g.nodeThreeObject((n: AtlasNode) => {
      const confidencePart = 0.6 + n.confidence * 1.2;
      const degree = this.nodeDegree.get(n.id) ?? 0;
      const degreePart = Math.sqrt(degree) * 0.55;
      const baseVal = confidencePart + degreePart; // mirrors nodeVal base (no emphasis boost)
      const visR = 49.5 * Math.cbrt(baseVal);
      const hitR = visR * 4.5; // 4.5× larger — generous hit area in 3D space
      const geo = new THREE.SphereGeometry(hitR, 6, 4);
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      return new THREE.Mesh(geo, mat);
    });
    g.nodeColor((n: AtlasNode) => this.colorForNode(n));
    // Visibility callbacks read from the precomputed sets so filter changes
    // can call g.refresh() without touching graphData — nodes stay at their
    // physics positions and the simulation never restarts.
    // During a legend hover preview ALL nodes/links are shown regardless of
    // the current category/source filter — the dim/bright colour callbacks
    // carry the emphasis instead of visibility. This lets the user see hidden
    // categories and sources "peek through" during hover.
    g.nodeVisibility((n: AtlasNode) => {
      if (this.previewLegendCategory !== null || this.previewLegendSource !== null) return true;
      return this.visibleNodeIds.has(n.id);
    });
    g.linkVisibility((l: AtlasLink) => {
      // Hard-locked categories are never rendered under any circumstance —
      // not by toggle, not by hover, not by peek-through. Check this first
      // before any other visibility logic.
      if (this.isCategoryHardLocked(l.category)) return false;
      // Predicted (GNN) edges are an opt-in OVERLAY, not a normal category.
      // They stay hidden during peek-through unless the user is specifically
      // hovering the `predicted` legend row OR has the predicted category
      // currently toggled on. Without this guard, hovering ANY source or
      // category would unhide predicted edges the user explicitly disabled,
      // polluting the view with predictions they don't want to see.
      if (l.category === 'predicted' &&
          !this.categoryVisible.predicted &&
          this.previewLegendCategory !== 'predicted') {
        return false;
      }
      // During a legend hover we want hidden edges to "peek through" so the
      // user can see all links for the hovered source/category. BUT with large
      // graphs (>10 K links) forcing ALL links visible in one refresh call
      // causes THREE.js to allocate geometry buffers for tens of thousands of
      // newly-visible edges on the main thread — a hard freeze. For large
      // graphs the color callbacks already apply the dim/bright emphasis on
      // visible links, which is sufficient feedback without the peek-through.
      if (this.previewLegendCategory !== null || this.previewLegendSource !== null) {
        if (this.allLinks.length <= 10_000) return true;
      }
      return this.visibleLinkIds.has(l.id);
    });
    g.nodeOpacity(0.92);
    // Disable the library's built-in nodeLabel tooltip — it uses d3.pointer()
    // internally, which produces wrong coordinates in the production Tauri
    // webview (tooltip stuck at the top of the canvas). We manage our own
    // tooltip div instead, positioned with raw clientX/clientY.
    g.nodeLabel('');
    this.initNodeTooltip();

    // Links: colored by category, width by weight, with arrowheads on
    // directional links sized proportional to weight.
    g.linkColor((l: AtlasLink) => this.colorForLink(l));
    g.linkOpacity(0.7);
    // GNN-predicted edges (the `.gnn` overlay) render as thin DASHED lines —
    // a deliberate contrast with the solid weighted tubes of real
    // connections, so a model prediction is never mistaken for a
    // deterministic edge. Real links return null here → three-forcegraph
    // builds its default tube.
    g.linkThreeObject((l: AtlasLink) => {
      if (l.category !== 'predicted') return null as unknown as THREE.Object3D;
      const line = makeDashedLink();
      // Keep a handle so previewHighlight() can dim/brighten this specific
      // dashed edge — its color is baked into its own material and never
      // passes through the linkColor accessor the real edges use.
      this.predictedLineObjs.set(l.id, line);
      return line as unknown as THREE.Object3D;
    });
    g.linkPositionUpdate((
      obj: THREE.Object3D,
      coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
      l: AtlasLink,
    ) => {
      if (l.category !== 'predicted') return undefined; // real links → default positioning
      positionDashedLink(obj, coords, this.edgeShape.get(l.id));
      return true;
    });
    // Edge thickness: weight-based base width. Directed edges carry a heavier
    // baseline than undirected ones — so the two kinds stay distinguishable,
    // and a directed edge (with its flowing particles) stays legible even on a
    // large graph zoomed out, where thin hairlines otherwise vanish. Incident
    // edges of a selected node thicken further to spotlight the neighborhood.
    g.linkWidth((l: AtlasLink) => {
      const base = Math.max(0.4, Math.min(5, 0.4 + l.weight * 2.0));
      if (this.selectedId !== null) {
        const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
        const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
        if (sId === this.selectedId || tId === this.selectedId) return base * 5;
      }
      return l.directed ? Math.max(1.4, Math.min(8, base * 1.8)) : base;
    });
    // Curve undirected edges that share a node pair with a directed edge —
    // the arc visually separates them from the straight directed line.
    // Directed edges stay straight so their particle animations are
    // unobstructed. Edges without a co-parallel directed partner also
    // stay straight (curvature 0 in edgeShape). The perf flag lets
    // DevTools testing suppress all curves in one shot.
    g.linkCurvature((l: AtlasLink) => {
      if (!globalThis.atlasPerf.curves) return 0;
      return this.edgeShape.get(l.id)?.curvature ?? 0;
    });
    g.linkCurveRotation((l: AtlasLink) => {
      if (!globalThis.atlasPerf.curves) return 0;
      return this.edgeShape.get(l.id)?.rotation ?? 0;
    });
    // Arrowheads on all directed edges. Tuned to be unmistakable:
    //   1) Length 40-72 (was 14-30, ~3x): at typical orbit distances the
    //      smaller cones disappeared into the cosmos shader. 3x larger
    //      reads clearly as an arrow rather than a dot near the midpoint.
    //   2) relPos 0.98 (was 0.94, now nearly at the target): the cone
    //      TIP sits just at the destination node's surface. Backing it
    //      off too far (0.9 or less) makes the arrow look detached and
    //      floating in the middle of the edge. We want the user to
    //      unambiguously read "this points TO that node."
    //   3) Solid opaque hex from CATEGORY_COLOR: three-forcegraph parses
    //      arrow color via `new THREE.Color(str)`, which drops alpha
    //      channels entirely. Bare hex avoids the case where a dimmed
    //      link's rgba(...) string lands as a malformed input.
    g.linkDirectionalArrowLength((l: AtlasLink) => (globalThis.atlasPerf.arrows && l.directed) ? Math.max(40, Math.min(72, 30 + l.weight * 28)) : 0);
    g.linkDirectionalArrowRelPos(0.98);
    g.linkDirectionalArrowColor((l: AtlasLink) => {
      // Solid CSS hex (no alpha). Brighter than the link itself so the
      // arrowhead is unmistakable against the dimmer edge shaft, even
      // when the edge has been faded by a selection/legend hover.
      const baseHex = this.baseColorForLink(l);
      return '#' + baseHex.toString(16).padStart(6, '0');
    });
    // Flowing particles along directional links — neural-pulse effect that
    // makes "this memory points to that one" feel alive. We control
    // visibility via the COUNT (not just color), because three-forcegraph
    // renders particles as Sprite materials whose opacity ignores the
    // alpha channel of the color string. Returning 0 here is the only
    // reliable way to hide a pulse on a non-incident edge during selection
    // / hover focus.
    g.linkDirectionalParticles((l: AtlasLink) => globalThis.atlasPerf.particles ? this.particleCountFor(l) : 0);
    g.linkDirectionalParticleSpeed((l: AtlasLink) => {
      if (!l.directed) return 0;
      // Deliberately slow — the pulse has to crawl slowly enough that the eye
      // can track WHICH WAY it flows; that flow is how the edge's direction
      // reads. Incident edges of a selected node pulse a touch faster.
      if (this.selectedId !== null) {
        const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
        const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
        if (sId === this.selectedId || tId === this.selectedId) {
          return 0.011 + Math.min(0.009, l.weight * 0.005);
        }
      }
      return 0.004 + Math.min(0.006, l.weight * 0.003);
    });
    g.linkDirectionalParticleColor((l: AtlasLink) => this.brightParticleColor(l));
    // Particle width: always large (6px) on directed edges so the neural
    // pulse is clearly visible at any zoom level or cluster distance.
    g.linkDirectionalParticleWidth((l: AtlasLink) => l.directed ? 6 : 0);

    // Physics tuning for an elastic, "alive" feel:
    //   - Low velocity decay → nodes carry momentum, drift smoothly.
    //   - Low alpha decay → disturbances propagate before settling.
    //   - Long cooldownTicks → simulation runs for a generous window after
    //     each kick (drag, data swap, etc.) before "resting."
    //   - Periodic reheat (set up below in startReheatLoop) → re-energizes
    //     the simulation every few seconds so the user sees constant
    //     gentle drift instead of a static frozen graph.
    //
    // We tried d3AlphaTarget for the constant-motion effect, but 3d-force-
    // graph's wrapper interacts oddly with non-zero targets — the renderer
    // would stop drawing entirely. The periodic-reheat approach is uglier
    // but reliable across library versions.
    g.d3VelocityDecay(this.opts.compact ? 0.4 : 0.25);
    g.d3AlphaDecay(this.opts.compact ? 0.02 : 0.012);
    // cooldownTicks used to be 1200 (~20s of physics after every reheat).
    // For graphs above ~800 nodes that meant the CPU stayed pegged for a
    // long visible window each cycle. 300 still produces ~5s of motion
    // after each reheat (which fires every 4s), so the graph feels alive
    // without holding the renderer hot indefinitely.
    g.cooldownTicks(this.opts.compact ? 120 : 300);
    g.warmupTicks(this.opts.compact ? 20 : 80);

    // Reheat loop is DISABLED by default. The original idea ("constant
    // alive motion") works fine at <500 nodes but at 2000+ nodes + 3000+
    // edges it pegs the CPU permanently — each reheat triggers ~5s of
    // active physics, and the curve / particle accessors all become hot
    // paths during those windows. The user reads it as "perpetuum mobile"
    // lag.
    //
    // New default: positions settle once after initial layout
    // (warmup + cooldown ticks), then the graph stays static. User can
    // re-enable motion via `aliveEnabled` toggle (toolbar / DevTools).
    //
    // Trade-off: graph reads as "settled" rather than "alive." The
    // alternative — constant lag at scale — was worse.
    this.aliveEnabled = true;

    if (!this.opts.compact) {
      // Per-link spring physics — heavier edges become stiffer springs and
      // longer at rest. Strength is dynamic so dragging boosts the pull
      // on a node's neighbors, making the graph follow the drag elastically
      // instead of lagging behind it. All values are deliberately gentle:
      // loose springs let the many-body repulsion + collision force push
      // dense clusters apart instead of yanking them inward.
      const lf = g.d3Force('link') as
        | undefined
        | { strength?: (fn: (l: AtlasLink) => number) => unknown; distance?: (fn: (l: AtlasLink) => number) => unknown };
      if (lf?.strength && lf?.distance) {
        // Store reference so onNodeDrag / onNodeDragEnd can call
        // lf.strength(fn) again to force d3 to re-cache per-link strengths.
        // d3-force evaluates the accessor ONCE at initialization — calling
        // .strength(fn) again is the only way to trigger re-evaluation.
        this.linkForce = lf as { strength?: (fn: (l: AtlasLink) => number) => unknown };
        // Default: all springs off — cluster / charge / collision own layout.
        lf.strength(() => 0);
        lf.distance(() => 600 * this.layoutScale);
      }
      this.applyChargeForce();
      // Collision force = a hard floor on inter-node distance. Bigger
      // radius than before (was 6 → 14) because the user's screenshot
      // still showed nodes piled on top of each other — 6 was barely
      // larger than the visible node radius. 14 gives every node a
      // ~2× diameter personal bubble. 3 iterations per tick for tighter
      // enforcement (collisions otherwise resolve slowly in dense graphs).
      g.d3Force(
        'collide',
        forceCollide().radius(() => 14 * this.layoutScale).strength(0.95).iterations(3),
      );

      // Source-file cluster force — two-phase:
      //
      // Phase 1 (0 – 4 s after setNodes): cubic-ease-out lerp from the
      //   cluster center toward each node's unique sub-anchor, so the
      //   source "explodes" outward into an organic constellation shape.
      //
      // Phase 2 (steady state): gentle constant pull toward sub-anchor so
      //   nodes stay in their home region even after alpha cools.  The
      //   floor is kept low (0.006) so repulsion can still spread nodes
      //   within the cluster — if the floor is too high everything packs
      //   back into a ball.
      const EXPLOSION_MS = 4000;
      g.d3Force('cluster', (alpha: number) => {
        const elapsed = Date.now() - this.explosionStartTime;
        const t = Math.min(1, elapsed / EXPLOSION_MS);
        // Cubic ease-out: fast at first, decelerates to a smooth stop.
        const progress = 1 - Math.pow(1 - t, 3);
        // Strong pull so nodes stay at their 3D sub-anchors even when the
        // link force pulls connected nodes together.
        //
        // Living-brain breathing: sub-anchor positions gently expand and
        // contract (±2% of their distance from cluster center).  All
        // nodes in a cluster breathe together; per-cluster phase offset
        // means adjacent clusters are slightly out of sync, giving the
        // whole graph a slow, organ-like pulse.
        const BREATH_PERIOD = 6_000; // ms per full inhale→exhale cycle
        const BREATH_AMP    = 0.02 * (this.brainVitality / 100); // scales with vitality
        const now_ms        = Date.now();
        const strength      = alpha * 0.22 + 0.035;
        for (const n of this.allNodes) {
          const center = this.clusterCenters.get(n.sourceFile ?? '');
          if (!center) continue;
          const sub = this.nodeSubAnchors.get(n.id);
          const node = n as AtlasNode & { vx?: number; vy?: number; vz?: number };
          // Interpolate pull target: cluster center → sub-anchor over explosion.
          let tx = sub ? center.x + (sub.x - center.x) * progress : center.x;
          let ty = sub ? center.y + (sub.y - center.y) * progress : center.y;
          let tz = sub ? center.z + (sub.z - center.z) * progress : center.z;
          // Breathing: scale anchor distance from cluster center.
          // Per-cluster phase from sourceFile hash (cheap: sum char codes).
          const ck = n.sourceFile ?? '';
          const clusterPhase = (ck.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 628) / 100;
          const bscale = 1 + BREATH_AMP * Math.sin((now_ms / BREATH_PERIOD) * 2 * Math.PI + clusterPhase);
          const fromCx = tx - center.x; const fromCy = ty - center.y; const fromCz = tz - center.z;
          tx = center.x + fromCx * bscale;
          ty = center.y + fromCy * bscale;
          tz = center.z + fromCz * bscale;
          // During a node drag the whole blob's pull target shifts toward the
          // dragged node so connected nodes follow it elastically. The offset
          // is cleared on drag-end, which lets the cluster force spring the
          // blob back to its original shape.
          const dragOff = this.clusterDragOffset.get(n.sourceFile ?? '');
          if (dragOff) { tx += dragOff.x; ty += dragOff.y; tz += dragOff.z; }
          node.vx = (node.vx ?? 0) + (tx - (n.x ?? 0)) * strength;
          node.vy = (node.vy ?? 0) + (ty - (n.y ?? 0)) * strength;
          node.vz = (node.vz ?? 0) + (tz - (n.z ?? 0)) * strength;
        }
      });
    }

    if (this.opts.compact) {
      g.linkDirectionalParticles(0);
      g.enableNodeDrag(false);
      g.enableNavigationControls(false);
    } else {
      // Default: clicking and dragging anywhere (including on nodes) rotates
      // the camera. Holding Cmd/Ctrl while dragging temporarily enables
      // node-drag (grab + move + pin on release). See onModKeyDown below.
      // Rationale: orbiting was being hijacked when the user happened to
      // click on a node — most of the time they wanted to rotate, not pin.
      g.enableNodeDrag(false);
      // Disable trackball's built-in wheel zoom — we replace it with a
      // cursor-aware lerp below. Trackball's default zoom dollies along
      // the camera direction toward the FIXED target; we want zoom to
      // converge on whatever the cursor is hovering over.
      const ctrls = g.controls() as {
        noZoom?: boolean;
        noRotate?: boolean;
        zoomSpeed?: number;
        staticMoving?: boolean;
        dynamicDampingFactor?: number;
        rotateSpeed?: number;
        panSpeed?: number;
        addEventListener?: (type: string, fn: () => void) => void;
      };
      if (ctrls) {
        // Disable TC's built-in wheel zoom — we replace it with cursor-aware
        // zoom in onWheel below.
        ctrls.noZoom = true;
        ctrls.zoomSpeed = 0;
        // TC owns all rotation natively. We let it do its job.
        // Damping: staticMoving=false gives a smooth coast after the user
        // releases. dynamicDampingFactor=0.12 settles in ~1.5s.
        ctrls.staticMoving = false;
        ctrls.dynamicDampingFactor = 0.12;
        ctrls.rotateSpeed = 1.6;
        ctrls.panSpeed = 0.08;
        // Track pointer-down position for node-drag cancel checks.
        this.opts.container.addEventListener('pointerdown', (e: PointerEvent) => {
          this.lastPointerDown = { x: e.clientX, y: e.clientY };
        });

        // Pause the "alive" reheat loop during active orbit. TC fires DOM-
        // style 'start' and 'end' events on every drag gesture.
        ctrls.addEventListener?.('start', () => {
          this.isOrbiting = true;
        });
        ctrls.addEventListener?.('end', () => {
          this.isOrbiting = false;
          this.lastOrbitEndMs = performance.now();
          // Cosmos loop is always running — it will resume idle oscillation
          // after ORBIT_COOLDOWN_MS once TC's damping has settled.
          this.startCosmosLoop();
        });

        // Button → action mapping. Three.js MOUSE values:
        //   ROTATE = 0  ·  DOLLY = 1 (zoom)  ·  PAN = 2
        // We:
        //   - leave LEFT as ROTATE (the everyday orbit)
        //   - flip MIDDLE from DOLLY → PAN (we already disabled wheel zoom
        //     here in favor of our cursor-aware handler, so DOLLY on
        //     middle did nothing useful)
        //   - leave RIGHT as PAN (default)
        const mb = (ctrls as unknown as { mouseButtons?: { LEFT: number; MIDDLE: number; RIGHT: number } }).mouseButtons;
        if (mb) {
          mb.MIDDLE = 2;
          mb.RIGHT = 2;
        }
        // Ctrl/Cmd held: left-drag switches from rotate → pan (camera move),
        // AND node-drag is enabled so clicking a node still pins it.
        // Released: left-drag reverts to rotate, node-drag off.
        this.onModKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Control' || e.key === 'Meta') {
            g.enableNodeDrag(true);
            // Switch left button from rotate (0) to pan (2) so dragging
            // on empty space translates the camera instead of spinning.
            if (mb) mb.LEFT = 2;
            this.opts.container.style.cursor = 'grab';
          }
        };
        this.onModKeyUp = (e: KeyboardEvent) => {
          if (e.key === 'Control' || e.key === 'Meta') {
            g.enableNodeDrag(false);
            if (mb) mb.LEFT = 0; // restore left → rotate
            this.opts.container.style.cursor = '';
          }
        };
        window.addEventListener('keydown', this.onModKeyDown);
        window.addEventListener('keyup', this.onModKeyUp);
        // Belt-and-suspenders: if the window loses focus while the user
        // is holding Cmd/Ctrl, reset to the default (no node-drag) so they
        // don't come back to find dragging unexpectedly pinning nodes.
        window.addEventListener('blur', () => {
          g.enableNodeDrag(false);
          if (mb) mb.LEFT = 0;
          this.opts.container.style.cursor = '';
        });
      }
      // We attach the custom wheel handler on the host container (not the
      // canvas the library injects, which can change identity) — passive:
      // false so we can preventDefault().
      this.opts.container.addEventListener('wheel', this.onWheel, { passive: false });
      // ── grab-to-rotate-pivot wiring (DISABLED — feature kept in code for
      //    future re-enable; methods + fields remain below for reference).
      //    To re-enable: uncomment the line below AND the matching
      //    removeEventListener in dispose() near the end of this file.
      // this.opts.container.addEventListener('pointerdown', this.onGrabPointerDown, true);
      // Mousemove suppressor — refresh the timestamp the reheat loop reads
      // so we don't shift nodes under the user's cursor while they hover.
      this.opts.container.addEventListener('pointermove', (e: PointerEvent) => {
        this.lastMouseMove = Date.now();
        // Suppress reheat while a node drag is in progress (graph is hot
        // from onNodeDrag pumping the sim directly).
        void e;
      });

      // Pre-offset the camera toward the right (non-legend) area immediately
      // so the graph appears in the correct position even during the ~1s
      // before zoomToFit() is called. Without this the user briefly sees the
      // graph centered behind the legend before the explicit zoom-to-fit fires.
      requestAnimationFrame(() => {
        const initCam = this.graph.camera() as THREE.PerspectiveCamera;
        const initCtrls = this.graph.controls() as { target?: THREE.Vector3 };
        if (!initCam || !initCtrls?.target) return;
        const rect = this.opts.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Wire the LOD camera-distance listener once controls are available.
        // OrbitControls fires 'change' every frame while the camera moves;
        // we debounce to 80ms so we only invalidate the link-color cache
        // when the user has paused — no per-frame full refresh.
        const ctrls = this.graph.controls() as {
          addEventListener?: (evt: string, cb: () => void) => void;
          target?: THREE.Vector3;
        };
        if (ctrls?.addEventListener) {
          ctrls.addEventListener('change', () => {
            const cam = this.graph.camera() as THREE.PerspectiveCamera;
            const tgt = (this.graph.controls() as { target?: THREE.Vector3 }).target;
            if (!cam || !tgt) return;
            const newDist = cam.position.distanceTo(tgt);
            // Only refresh when we cross a LOD boundary (> 60-unit hysteresis
            // so orbiting at constant distance doesn't spam refreshes).
            const prevBucket = this.lodBucket(this.lodCamDist);
            const newBucket  = this.lodBucket(newDist);
            this.lodCamDist = newDist;
            if (prevBucket !== newBucket) {
              if (this.lodRefreshTimer !== null) clearTimeout(this.lodRefreshTimer);
              this.lodRefreshTimer = setTimeout(() => {
                this.linkColorCache.clear();
                this.graph.refresh();
                this.lodRefreshTimer = null;
              }, 80);
            }
          });
        }
      });
    }
  }

  /** Maps a camera distance to a discrete LOD bucket (0 = close, 1 = medium, 2 = far).
   *  Crossing a bucket boundary triggers a link-color cache invalidation so the
   *  cross-cluster semantic edges fade in/out as the user zooms. */
  private lodBucket(dist: number): number {
    if (dist < 250) return 0;   // zoomed in — close to a cluster
    if (dist < 550) return 1;   // mid-range
    return 2;                   // overview — full scene visible
  }

  /**
   * Find the world-space point under the cursor, used as the zoom pivot.
   *
   * Strategy: weighted average of the depth of nearby nodes projected to
   * screen space. Nodes within RADIUS_PX of the cursor contribute to the
   * weighted depth, biased toward the closest ones. Falls back to the
   * controls target when no nodes are near the cursor.
   *
   * Result is always on the cursor ray — zoom never changes horizontal drift.
   */
  private computeCursorPivot(
    clientX: number,
    clientY: number,
    cam: THREE.PerspectiveCamera,
    fallbackTarget: THREE.Vector3,
  ): THREE.Vector3 {
    const rect = this.opts.container.getBoundingClientRect();
    const cx   = clientX - rect.left;
    const cy   = clientY - rect.top;

    // Cursor ray — pivot will always lie ON this ray so orbiting never
    // changes the camera's depth relative to the scene (no zoom artefact).
    const ndc = new THREE.Vector2(
      (cx / rect.width)  * 2 - 1,
      -(cy / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);
    const rayDir = raycaster.ray.direction.clone().normalize();

    const camFwd = new THREE.Vector3();
    cam.getWorldDirection(camFwd);

    // Collect nodes within RADIUS_PX of the cursor on screen.
    // For each, compute rayT = depth along the cursor ray (not world pos).
    // We weight by 1/screenDistSq so the nearest nodes dominate the depth.
    const RADIUS_PX = 220;
    const MAX_NODES = 6;
    const radiusSq  = RADIUS_PX * RADIUS_PX;

    type Hit = { rayT: number; screenDistSq: number };
    const hits: Hit[] = [];

    const proj = new THREE.Vector3();

    for (const node of this.allNodes) {
      if (node.x === undefined || node.y === undefined || node.z === undefined) continue;

      const worldPos = new THREE.Vector3(node.x, node.y, node.z);
      const toNode   = worldPos.clone().sub(cam.position);

      // Skip nodes behind the camera.
      if (toNode.dot(camFwd) <= 0) continue;

      // Depth along the cursor ray at this node (not the node's world pos).
      const rayT = toNode.dot(rayDir);
      if (rayT <= 0) continue;

      // Project to screen to measure proximity to cursor.
      proj.copy(worldPos).project(cam);
      if (proj.z < -1 || proj.z > 1) continue;

      const px           = ((proj.x + 1) / 2) * rect.width;
      const py           = ((1 - proj.y) / 2) * rect.height;
      const screenDistSq = (px - cx) ** 2 + (py - cy) ** 2;

      if (screenDistSq <= radiusSq) {
        hits.push({ rayT, screenDistSq });
      }
    }

    if (hits.length > 0) {
      // Take the N closest by screen distance, then weighted-average their depth.
      hits.sort((a, b) => a.screenDistSq - b.screenDistSq);
      const nearest = hits.slice(0, MAX_NODES);

      let weightedDepth = 0;
      let wTotal        = 0;
      for (const h of nearest) {
        // Guard against exactly-zero screen distance (cursor exactly on node).
        const w = 1 / Math.max(h.screenDistSq, 1);
        weightedDepth += h.rayT * w;
        wTotal        += w;
      }
      weightedDepth /= wTotal;

      // Return the point ON the cursor ray at the weighted depth.
      // Pivot is always on the ray → orbit never changes scene depth → no zoom.
      return cam.position.clone().addScaledVector(rayDir, weightedDepth);
    }

    // Fallback: scene centroid projected onto the camera's FORWARD direction
    // (not the cursor ray).  Projecting onto rayDir breaks when the cursor
    // isn't aimed directly at the centroid — the dot product can be near zero,
    // making fwdDist ≈ 0 and freezing zoom.  Using camFwd gives a stable depth
    // that scales with actual camera distance → logarithmic zoom at any scale.
    // We still return a point ON the cursor ray so the zoom pivot tracks the
    // cursor position (the *amount* is camFwd-based, the *direction* is rayDir).
    if (this.allNodes.length > 0) {
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (const n of this.allNodes) {
        if (n.x !== undefined) { sx += n.x; sy += n.y!; sz += n.z!; cnt++; }
      }
      if (cnt > 0) {
        const centroid = new THREE.Vector3(sx / cnt, sy / cnt, sz / cnt);
        const fwdDepth = centroid.clone().sub(cam.position).dot(camFwd);
        if (fwdDepth > 1) return cam.position.clone().addScaledVector(rayDir, fwdDepth);
      }
    }
    // No nodes yet: use TC.target depth along camera forward (no hard cap —
    // per-frame budget in onWheel handles rate-limiting).
    const fwdFallback = fallbackTarget.clone().sub(cam.position).dot(camFwd);
    return cam.position.clone().addScaledVector(rayDir, Math.max(1, fwdFallback));
  }


  // ─────────────────────────────────────────────────────────────────────────
  // COSMOS LOOP  (inertia → idle spin)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start (or restart) the cosmos RAF loop.
   *
   * TrackballControls owns interactive rotation and provides its own damping
   * inertia (staticMoving=false, dynamicDampingFactor=0.12).  This loop's
   * only job is the IDLE PHASE: after TC's inertia has settled, the camera
   * rocks gently within a bounded sinusoidal window so the graph never sits
   * completely dead.
   *
   * Guard: cosmos oscillation waits ORBIT_COOLDOWN_MS after the last TC 'end'
   * event before starting, giving TC's damping time to fully settle (~1.5 s).
   */
  private startCosmosLoop(): void {
    if (this.cosmosLoopId !== null) return; // idempotent

    // ── Motion constants ────────────────────────────────────────────────────
    // Two superimposed azimuth sinusoids + one elevation — incommensurate
    // periods give an organic, non-repeating feel.
    const AZ_AMP1  = 0.045; // rad ≈ 2.6°
    const AZ_T1    = 31_000; // ms
    const AZ_AMP2  = 0.020; // rad ≈ 1.1°
    const AZ_T2    = 13_700; // ms (incommensurate with T1)
    const EL_AMP   = 0.030; // rad ≈ 1.7°
    const EL_T     = 23_000; // ms
    // How long after TC orbit ends before we take over camera oscillation.
    // Must be ≥ TC damping settling time (~1.5 s at dampingFactor=0.12).
    const ORBIT_COOLDOWN_MS = 1_800;
    // Jelly integration: per-node velocities applied directly to node positions.
    const JELLY_DECAY = 0.0017; // per ms — half-life ≈ 400 ms

    const PI2 = 2 * Math.PI;
    const POLE_CLAMP = 0.35; // 20° guard — keeps lookAt numerically stable
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(now - lastTime, 50);
      lastTime = now;

      // ── Jelly integration ─────────────────────────────────────────────────
      // Dissipate any residual node velocity from drag gestures.
      if (!this.isOrbiting && this.jellyVelocities.size > 0) {
        const decayFactor = Math.exp(-JELLY_DECAY * dt);
        const nodes = this.graph.graphData().nodes as Array<{
          id?: string; x?: number; y?: number; z?: number;
        }>;
        for (const node of nodes) {
          const id = node.id ?? '';
          const jv = this.jellyVelocities.get(id);
          if (!jv) continue;
          node.x = (node.x ?? 0) + jv.vx * dt;
          node.y = (node.y ?? 0) + jv.vy * dt;
          node.z = (node.z ?? 0) + jv.vz * dt;
          jv.vx *= decayFactor; jv.vy *= decayFactor; jv.vz *= decayFactor;
          if (Math.abs(jv.vx) < 0.0001 && Math.abs(jv.vy) < 0.0001 && Math.abs(jv.vz) < 0.0001) {
            this.jellyVelocities.delete(id);
          }
        }
      }

      // ── Node size pulsation ("Living Brain") ────────────────────────────
      // Each node oscillates between 1× and 2× its normal size on an
      // independent sinusoid.  Direct Three.js scale mutation — no g.refresh()
      // required — so it runs at full 60 fps without recomputing graph data.
      {
        type NodeWithObj = AtlasNode & { __threeObj?: THREE.Object3D };
        const graphNodes = this.graph.graphData().nodes as NodeWithObj[];
        for (const n of graphNodes) {
          const obj = n.__threeObj;
          if (!obj) continue;
          if (this.aliveEnabled) {
            const phase  = this.nodePulsePhase.get(n.id) ?? 0;
            const period = this.nodePulsePeriod.get(n.id) ?? 3000;
            const amp = this.brainVitality / 100;
            // Scale ∈ [1.0, 1.0+amp]: lower vitality → subtler pulsation.
            const s = 1 + amp * (Math.sin(phase + PI2 * now / period) + 1) / 2;
            obj.scale.setScalar(s);
          } else if (obj.scale.x !== 1) {
            obj.scale.setScalar(1); // restore once when alive is toggled off
          }
        }
      }

      // ── Instanced Points node layer (task #42, Stage A) ─────────────────
      // Copy sim positions + pulsation into the Points buffers every frame.
      // Guarded: a fault in the experimental layer must never break the atlas.
      if (this.nodePointsEnabled) {
        try { this.syncNodePointsFrame(now); }
        catch (e) {
          console.error('[atlas] node-points sync failed — disabling layer:', e);
          this.nodePointsEnabled = false;
          this.teardownNodePointsLayer();
        }
      }

      // Skip camera oscillation if: motion disabled, TC orbit active, or
      // still within the post-orbit cooldown window.
      if (
        !this.aliveEnabled ||
        this.isOrbiting ||
        (now - this.lastOrbitEndMs) < ORBIT_COOLDOWN_MS
      ) {
        this.cosmosLoopId = requestAnimationFrame(tick);
        return;
      }

      const cam = this.graph.camera() as THREE.PerspectiveCamera | null;
      const ctrlsForIdle = this.graph.controls() as { target?: THREE.Vector3 };
      if (!cam || !ctrlsForIdle?.target) { this.cosmosLoopId = null; return; }

      // ── IDLE PHASE — bounded delta-sine oscillation ───────────────────────
      // Delta-sine: az = AMP*(sin(now) − sin(now−dt)) gives the correct
      // incremental rotation step from a position-space sinusoid.  Camera
      // rocks within ±(AZ_AMP1+AZ_AMP2) ≈ ±4° — never drifts, always returns.
      const tp = now - dt;
      const az = AZ_AMP1 * (Math.sin(PI2 * now / AZ_T1) - Math.sin(PI2 * tp / AZ_T1))
               + AZ_AMP2 * (Math.sin(PI2 * now / AZ_T2) - Math.sin(PI2 * tp / AZ_T2));
      const el = EL_AMP  * (Math.sin(PI2 * now / EL_T)  - Math.sin(PI2 * tp / EL_T));

      // Pivot = TC's current target (keeps oscillation centered on the scene).
      const pivot = ctrlsForIdle.target.clone();

      // Pole clamp: prevent flip when camera approaches vertical.
      const fwdCur = new THREE.Vector3();
      cam.getWorldDirection(fwdCur);
      const fwdPhi  = Math.acos(Math.max(-1, Math.min(1, fwdCur.y)));
      let clampedEl = el;
      if (fwdPhi - el < POLE_CLAMP && el > 0) clampedEl = 0;
      if (fwdPhi - el > Math.PI - POLE_CLAMP && el < 0) clampedEl = 0;

      // Build quaternion: azimuth around camera-local Y, elevation around X.
      const camUp    = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
      const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
      const qAz = new THREE.Quaternion().setFromAxisAngle(camUp,    az);
      const qEl = new THREE.Quaternion().setFromAxisAngle(camRight, clampedEl);
      const q   = new THREE.Quaternion().multiplyQuaternions(qAz, qEl);

      // Rotate camera position around pivot, then rotate orientation.
      cam.position.sub(pivot).applyQuaternion(q).add(pivot);
      cam.quaternion.premultiply(q).normalize();
      cam.updateMatrixWorld();
      // No reorthogonalization here — forcing cam.up to world-Y would snap
      // any roll that TC's inertia left, causing the post-inertia jump.
      // TC's lookAt(target) on the next frame keeps orientation consistent.

      this.cosmosLoopId = requestAnimationFrame(tick);
    };

    this.cosmosLoopId = requestAnimationFrame(tick);
  }

  /**
   * Set the many-body (charge) repulsion to a magnitude that scales with
   * the graph size. Called from configureRenderer at construction and again
   * from setNodes() whenever the node count changes — so an engram that
   * grows from 20 → 200 nodes proportionally spreads out instead of
   * collapsing inward.
   */
  /**
   * Start a gentle, recurring reheat — every 4 seconds, the simulation's
   * alpha gets reset to 1 and forces re-energize. Combined with our
   * cooldown / decay constants, this yields the constant-drift "alive"
   * look without breaking the renderer the way d3AlphaTarget does in
   * 3d-force-graph's wrapper.
   */
  private startReheatLoop(): void {
    if (this.reheatInterval !== null) return;
    // Skip reheat entirely for large graphs — each burst runs cooldownTicks
    // frames of main-thread physics and visibly freezes navigation.
    if (this.reheatIntervalMs() === 0) return;
    this.reheatInterval = setInterval(() => {
      // Hard kill-switch wins — user toggled motion OFF from the toolbar.
      if (!this.aliveEnabled) return;
      // Perf A/B flag — useful for "is the reheat what's making my CPU
      // hot?" comparisons from DevTools without restarting.
      if (!globalThis.atlasPerf.reheat) return;
      // Don't reheat while the page is hidden — wastes CPU on a window
      // the user can't see. The visibilitychange listener wired below
      // also stops the render loop entirely, but this catches the case
      // where the timer happens to fire during the brief gap between
      // hide event and animation pause.
      if (typeof document !== 'undefined' && document.hidden) return;
      // Skip the reheat under any of these conditions:
      //   - User is actively dragging a node (onNodeDrag pumps the sim itself).
      //   - User is orbiting the camera (start/end events track this).
      //   - The mouse moved over the canvas within the last 6s — the user
      //     is targeting something, don't shift the floor under them.
      //   - The user clicked empty canvas within the last 30s — a
      //     deliberate "stop the motion" gesture, give them stillness.
      // Once all conditions are clear (idle, no recent move/click), the
      // gentle drift resumes on the next tick.
      if (this.draggingId !== null) return;
      if (this.isOrbiting) return;
      const now = Date.now();
      if (now - this.lastMouseMove < SUPPRESS_AFTER_MOVE_MS) return;
      if (now - this.lastEmptyClick < SUPPRESS_AFTER_CLICK_MS) return;
      this.graph.d3ReheatSimulation();
    }, this.reheatIntervalMs());
  }

  /** Reheat cadence scales with graph size. Small graphs can afford
   *  the "alive" 4s breathing; large graphs would burn constant CPU on
   *  full-physics ticks the user wouldn't even notice past the dense
   *  cloud. Crossover thresholds chosen by feel:
   *    < 800 nodes  →  4s   (original "alive" cadence)
   *    < 1500 nodes →  10s  (still breathing but not pegging the CPU)
   *    ≥ 1500 nodes →  20s  (mostly still; rare gentle stirs)
   */
  private reheatIntervalMs(): number {
    if (this.brainVitality < 10) return 0;
    const N = this.allNodes.length;
    let base: number;
    if (N < 800)  base = 4_000;
    else if (N < 1500) base = 10_000;
    else return 0;
    // Map vitality 0-100 → 25%-100% of base interval (higher vitality = faster reheats).
    return Math.round(base / (this.brainVitality / 100 * 0.75 + 0.25));
  }

  private applyChargeForce(): void {
    const chargeForce = this.graph.d3Force('charge') as
      | undefined
      | { strength?: (s: number) => unknown; distanceMax?: (d: number) => unknown };
    // Repulsion is the strongest knob for breaking up dense hub clusters,
    // so we crank it: was -45 → -90 per node, with layoutScale on top.
    // distanceMax caps how far repulsion reaches — without it, very
    // distant nodes would still feel some push and the whole graph drifts
    // outward forever. 200 keeps repulsion local-ish.
    // Repulsion is stronger now that the link force is zeroed out — without
    // spring attraction pulling nodes together, repulsion is the only force
    // spreading nodes within a blob. distanceMax caps it to the blob radius
    // so it doesn't bleed across cluster boundaries.
    chargeForce?.strength?.(-160 * this.layoutScale);
    chargeForce?.distanceMax?.(400 * this.layoutScale);
  }

  /**
   * Cursor-aware dolly. Each wheel tick:
   *   1. Project the cursor's NDC coords onto a plane through the camera's
   *      current target, perpendicular to the view direction. This gives a
   *      world-space "point under the cursor."
   *   2. Lerp BOTH the camera position AND the orbit target toward that
   *      point by a small factor (zoom in) or away from it (zoom out).
   *
   * The result: zooming feels anchored to wherever you're looking, the way
   * Blender / Figma / 3D editors do it. Trackball's rotation still pivots
   * around the moving target, so rotation also becomes cursor-aware as a
   * side effect.
   */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const cam = this.graph.camera() as THREE.PerspectiveCamera;
    const ctrls = this.graph.controls() as { target?: THREE.Vector3; update?: () => void };
    const target = ctrls?.target;
    if (!cam || !target) return;
    const container = this.opts.container;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Normalize deltas across deltaMode units (pixel / line / page).
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= window.innerWidth; dy *= window.innerHeight; }

    // Ctrl/Cmd held → pan. Translates both camera and target in the view
    // plane by the wheel delta, mapped from screen pixels to world units
    // via the camera's FOV. Trackpad two-finger scroll has deltaX + deltaY
    // both populated, so this gives 2D pan from a single gesture.
    if (e.ctrlKey || e.metaKey) {
      // World-space right/up vectors of the camera.
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      // World units per screen pixel at the depth of the orbit target.
      // Standard perspective math: at distance d from camera, the visible
      // height is 2 × d × tan(fov/2). Per-pixel scale is that / clientHeight.
      const dist = cam.position.distanceTo(target);
      const fovRad = ((cam.fov ?? 45) * Math.PI) / 180;
      const unitsPerPx = (2 * Math.tan(fovRad / 2) * dist) / rect.height;
      // Scroll right (positive dx) should drag the world left so the
      // camera "moves right" — content flows in the natural direction
      // for trackpad gestures.
      const offX = right.multiplyScalar(-dx * unitsPerPx);
      const offY = up.multiplyScalar(dy * unitsPerPx);
      const offset = offX.add(offY);
      cam.position.add(offset);
      target.add(offset);
      ctrls.update?.();
      return;
    }

    // True cursor-aware zoom: move the camera toward (or away from) the
    // world-space point that sits under the cursor.  The pivot stays fixed in
    // screen space as you scroll — exactly like Blender / Figma / 3D apps.
    //
    // Lock the pivot for the duration of one RAF frame so several trackpad
    // events that arrive before the next render all converge on the same point.
    if (this.zoomPivotLocked === null) {
      this.zoomPivotLocked = this.computeCursorPivot(e.clientX, e.clientY, cam, target);
      this.zoomFrameAccum  = 0;
      requestAnimationFrame(() => { this.zoomPivotLocked = null; this.zoomFrameAccum = 0; });
    }
    const pivot    = this.zoomPivotLocked;
    const toPivot  = pivot.clone().sub(cam.position);
    const pivotDist = toPivot.length();
    if (pivotDist < 1) return; // camera is essentially ON the pivot — skip

    // Clamp per-event delta; cap total frame budget at ±30 % of pivot distance.
    const clamped  = Math.max(-60, Math.min(60, dy));
    const rawFactor = -clamped * 0.0015; // negative dy = scroll up = zoom in
    const MAX_FRAME_FACTOR = 0.30;
    const remaining = MAX_FRAME_FACTOR - Math.abs(this.zoomFrameAccum);
    if (remaining <= 0) return;
    const factor = Math.sign(rawFactor) * Math.min(Math.abs(rawFactor), remaining);
    this.zoomFrameAccum += Math.abs(factor);

    // Move BOTH camera AND target by the same world-space delta toward the
    // cursor pivot.  This keeps the pivot at the same screen position
    // (cursor-aware zoom) while preserving the camera→target vector so TC
    // never sees a change in orientation and won't apply a corrective
    // lookAt rotation on its next update() call.
    //
    //   delta = factor × (pivot − cam.position)
    //   C' = C + delta,   T' = T + delta   →   C'−T' = C−T  ✓
    //
    // toPivot is already a fresh clone (pivot.clone().sub(cam.position)),
    // so multiplyScalar mutates the clone — no aliasing issue.
    const delta = toPivot.multiplyScalar(factor);
    cam.position.add(delta);
    target.add(delta);
    // No ctrls.update() call needed: TC's render loop handles it, and
    // since _eye = cam−target is unchanged, there is nothing to correct.
  };

  // ── BEGIN: grab-to-rotate-pivot (cut this whole block to revert) ──────────
  //
  // Goal: when the user starts a left-click drag, rotation should pivot
  // around the 3D point under the cursor at grab-start — Blender / Figma /
  // CAD style — instead of around TrackballControls' drifting `target`.
  //
  // We can't just set `controls.target` and let TC handle the rotation
  // because TC's update() calls `camera.lookAt(target)` every frame, which
  // would re-aim the camera and SNAP the orientation when target moves far
  // from the camera's forward axis. So during the grab we:
  //   1. Disable TC entirely (ctrls.enabled = false) so update() is a no-op
  //   2. Apply rotation manually: rotate (cam.position - pivot) by a
  //      quaternion built from the mouse delta, then premultiply the same
  //      quaternion onto cam.quaternion so orientation rotates in lockstep
  //   3. On release, realign TC's target to a point in front of the new
  //      camera orientation BEFORE re-enabling — so TC's first post-grab
  //      update() finds target already consistent and doesn't snap.
  //
  // Drag threshold (~4px) is critical: without it, single clicks would
  // capture the pointer and break node selection. Under threshold → let
  // the click bubble normally to TC's selection handlers.

  private onGrabPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Don't capture yet — wait for movement to know if this is a drag or a click.
    this.grabStartX = e.clientX;
    this.grabStartY = e.clientY;
    this.grabPendingPointerId = e.pointerId;
    this.grabActive = false;
    this.grabPivot = null;
    this.opts.container.addEventListener('pointermove', this.onGrabPointerMove);
    this.opts.container.addEventListener('pointerup', this.onGrabPointerUp);
    this.opts.container.addEventListener('pointercancel', this.onGrabPointerUp);
  };

  private onGrabPointerMove = (e: PointerEvent): void => {
    if (this.grabPendingPointerId !== e.pointerId) return;

    // ── Threshold gate: cross 4px before taking over from TC ─────────────
    if (!this.grabActive) {
      const ddx = e.clientX - this.grabStartX;
      const ddy = e.clientY - this.grabStartY;
      if (Math.sqrt(ddx * ddx + ddy * ddy) < 4) return;

      const cam = this.graph.camera() as THREE.PerspectiveCamera;
      const ctrls = this.graph.controls() as { target?: THREE.Vector3; enabled?: boolean };
      if (!cam || !ctrls?.target) return;

      // Pivot anchors at the cursor's 3D location at GRAB START — not
      // the current cursor position — so rotation feels anchored to
      // where the user clicked.
      this.grabPivot = this.computeCursorPivot(this.grabStartX, this.grabStartY, cam, ctrls.target);
      this.grabLastX = e.clientX;
      this.grabLastY = e.clientY;
      this.grabActive = true;
      ctrls.enabled = false;
      try { this.opts.container.setPointerCapture(e.pointerId); } catch { /* not all browsers */ }
    }

    if (!this.grabPivot) return;
    const cam = this.graph.camera() as THREE.PerspectiveCamera;
    if (!cam) return;

    const dx = e.clientX - this.grabLastX;
    const dy = e.clientY - this.grabLastY;
    this.grabLastX = e.clientX;
    this.grabLastY = e.clientY;

    const rect = this.opts.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Sensitivity: dragging a full screen width = 180° of rotation. Matches
    // typical 3D-viewer feel (Blender's default, Three.js editor, etc.).
    const azim  = (-dx / rect.width)  * Math.PI;
    const polar = (-dy / rect.height) * Math.PI;

    // Horizontal uses WORLD UP (not camera up) to avoid accumulating roll
    // when the user does mixed h+v gestures. Vertical uses the camera's
    // current RIGHT axis (in world space) so up/down tilt is screen-relative.
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();

    const qH = new THREE.Quaternion().setFromAxisAngle(worldUp, azim);
    const qV = new THREE.Quaternion().setFromAxisAngle(right, polar);
    const q = qH.multiply(qV); // combined rotation

    // Rotate camera position around the pivot.
    const offset = cam.position.clone().sub(this.grabPivot);
    offset.applyQuaternion(q);
    cam.position.copy(this.grabPivot).add(offset);

    // Apply the SAME rotation to camera orientation. premultiply so the
    // rotation acts in world space, not local — this preserves the
    // relative view-direction-vs-pivot geometry exactly.
    cam.quaternion.premultiply(q);
  };

  private onGrabPointerUp = (e: PointerEvent): void => {
    if (this.grabPendingPointerId !== e.pointerId) return;

    if (this.grabActive) {
      const cam = this.graph.camera() as THREE.PerspectiveCamera;
      const ctrls = this.graph.controls() as { target?: THREE.Vector3; enabled?: boolean; update?: () => void };
      // Realign TC's target so the first post-grab update() doesn't snap.
      // Place target on the camera's forward axis at the same depth as the
      // pivot was — lookAt(target) becomes a no-op for the current orientation.
      if (cam && ctrls?.target && this.grabPivot) {
        const pivotDist = cam.position.distanceTo(this.grabPivot);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
        ctrls.target.copy(cam.position).addScaledVector(fwd, pivotDist);
      }
      if (ctrls) ctrls.enabled = true;
      try { this.opts.container.releasePointerCapture(e.pointerId); } catch { /* not captured / browser quirk */ }
    }

    this.grabActive = false;
    this.grabPivot = null;
    this.grabPendingPointerId = null;
    this.opts.container.removeEventListener('pointermove', this.onGrabPointerMove);
    this.opts.container.removeEventListener('pointerup', this.onGrabPointerUp);
    this.opts.container.removeEventListener('pointercancel', this.onGrabPointerUp);
  };
  // ── END: grab-to-rotate-pivot ─────────────────────────────────────────────

  private nodeTipEl: HTMLDivElement | null = null;
  private nodeTipText: string | null = null;
  /** When true, the node hover tooltip is suppressed entirely. Set during
   *  Presentation Mode so hovering a node can't surface its raw text (which
   *  would bypass the ████ label redaction). */
  private hoverSuppressed = false;
  /** True only while the pointer is actually over the atlas canvas — gates the
   *  hover tooltip so moving nodes (settle/ingest) drifting under a stale
   *  raycaster position don't flash labels when the mouse isn't on the graph. */
  private pointerInsideCanvas = false;

  private initNodeTooltip(): void {
    const container = this.opts.container;

    // Create the tooltip div once and attach it to the container.
    const tip = document.createElement('div');
    tip.className = 'atlas-node-tip';
    tip.style.display = 'none';
    container.appendChild(tip);
    this.nodeTipEl = tip;

    // onNodeHover: set content (library fires this on raycaster hits).
    this.graph.onNodeHover((node) => {
      // Presentation Mode: a hover tip would render the node's raw text,
      // bypassing the redaction bars. Suppress it outright while masked.
      if (this.hoverSuppressed) {
        this.nodeTipText = null;
        tip.style.display = 'none';
        return;
      }
      const n = node as AtlasNode | null;
      // Suppress unless the pointer is genuinely over the canvas — the library
      // re-raycasts every frame from the last pointer position, so moving nodes
      // would otherwise flash labels with the mouse nowhere near the graph.
      if (!n || !this.pointerInsideCanvas) {
        this.nodeTipText = null;
        tip.style.display = 'none';
        return;
      }
      const raw = n.text ?? '';
      this.nodeTipText = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      tip.textContent = this.nodeTipText;
      tip.style.display = 'block';
    });

    // mousemove: position using clientX/clientY - containerRect to avoid
    // the d3.pointer coordinate bug in the production Tauri webview.
    container.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.nodeTipText || !this.nodeTipEl) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;
      const tipW = tip.offsetWidth || 260;
      const tipH = tip.offsetHeight || 48;
      // Flip left/above when near the right or bottom edge.
      const left = x + tipW + 18 > w ? x - tipW - 6 : x + 14;
      const top  = y + tipH + 24 > h ? y - tipH - 6 : y + 18;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top  = `${Math.max(0, top)}px`;
    });

    container.addEventListener('mouseenter', () => { this.pointerInsideCanvas = true; });
    container.addEventListener('mouseleave', () => {
      this.pointerInsideCanvas = false;
      this.nodeTipText = null;
      if (this.nodeTipEl) this.nodeTipEl.style.display = 'none';
    });
  }

  private wireEvents(): void {
    const g = this.graph;

    // CMD/Ctrl + click anywhere on the canvas → fit the entire graph into
    // view in its current 3D orientation (no camera rotation, just zoom/pan).
    this.opts.container.addEventListener('click', (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.stopPropagation();
        this.zoomToFit(700, 40);
      }
    }, { capture: true });

    g.onNodeClick((n: AtlasNode) => {
      // Toggle: clicking the same node a second time clears the selection.
      // Makes "give me my context back" a single-click action, same target
      // the user just looked at.
      if (this.selectedId === n.id) {
        this.selectedId = null;
        this.previewHighlightId = null;
        this.restylePredictedEdges();
        this.graph.refresh();
        this.opts.onSelect?.(null);
        return;
      }
      this.selectedId = n.id;
      this.previewHighlightId = null;
      // Move the orbit pivot to the selected node so subsequent mouse-drag
      // rotations immediately pivot around it. Camera position doesn't
      // change — only the rotation center shifts. This is safe at click
      // time (no gesture in flight), so there's no mid-drag jolt.
      this.setOrbitPivotTo(n);
      this.restylePredictedEdges();
      this.graph.refresh();
      this.opts.onSelect?.(n);
    });
    g.onBackgroundClick(() => {
      this.selectedId = null;
      this.previewHighlightId = null;
      // Deliberate "stop the motion" gesture. The reheat loop reads this
      // timestamp and skips its tick for the next ~30s, so the user can
      // hunt for the node they want to click without nodes drifting
      // underneath the cursor.
      this.lastEmptyClick = Date.now();
      // Critical: force a re-render so the color/size accessors are
      // re-evaluated with the cleared selection state. Without this the
      // graph stays visually "stuck" on the dim-non-neighbors look until
      // the next event happens to trigger a refresh.
      this.restylePredictedEdges();
      this.graph.refresh();
      this.opts.onSelect?.(null);
    });
    // Drag lifecycle:
    //   onNodeDrag      → fires repeatedly while dragging. We track which
    //                     node is held, reheat the simulation each tick so
    //                     other nodes keep responding (the library cools
    //                     toward 0 by default), and rely on the dynamic
    //                     link-force strength to amplify the tug.
    //   onNodeDragEnd   → pin the dropped node where the user released it.
    //                     Wave continues for ~5–10s as the simulation
    //                     dissipates the energy through the springs.
    g.onNodeDrag((n: AtlasNode) => {
      if (this.draggingId !== n.id) {
        this.draggingId = n.id;
        // Re-evaluate per-link strengths now that draggingId is set.
        // d3-force caches strength values at init time; calling .strength()
        // again forces it to recompute per-link from the current accessor.
        const dragId = n.id;
        this.linkForce?.strength?.((l: AtlasLink) => {
          const ll = l as AtlasLink & { from?: string; to?: string; a?: string; b?: string };
          const incident = ll.from === dragId || ll.to === dragId
                        || ll.a   === dragId || ll.b  === dragId;
          // Incident edges: strong spring so neighbors follow closely.
          // Non-incident: light pull so the effect propagates outward.
          return incident ? 0.7 : 0.12;
        });
      }
      // Shift the entire blob's cluster-force pull target toward the dragged
      // node so the rest of the blob follows elastically. The fraction (0.55)
      // means the blob chases ~55% of the drag displacement — enough to feel
      // connected without the blob collapsing onto the dragged node.
      const dragSourceFile = this.nodeSourceFileMap.get(n.id) ?? '';
      const dragSub = this.nodeSubAnchors.get(n.id);
      if (dragSub && n.x !== undefined && n.y !== undefined && n.z !== undefined) {
        const BLOB_PULL = 0.55;
        this.clusterDragOffset.set(dragSourceFile, {
          x: (n.x - dragSub.x) * BLOB_PULL,
          y: (n.y - dragSub.y) * BLOB_PULL,
          z: (n.z - dragSub.z) * BLOB_PULL,
        });
      }
      // Keep alpha hot so the simulation actively integrates forces.
      this.graph.d3ReheatSimulation();
    });
    g.onNodeDragEnd((n: AtlasNode) => {
      this.draggingId = null;
      // Clear the pin so the simulation takes over.
      n.fx = undefined;
      n.fy = undefined;
      n.fz = undefined;
      // Clear the blob-anchor drag offset so the cluster force immediately
      // starts pulling nodes back to their original sub-anchor positions.
      // Combined with the elastic link-force phase below, this produces the
      // rubber-band snap-back feel.
      this.clusterDragOffset.clear();
      // Cancel any previous elastic timer.
      if (this.elasticTimer !== null) clearTimeout(this.elasticTimer);
      // Elastic phase: re-evaluate with moderate strength on ALL edges so
      // displaced nodes snap back toward each other (rubber-band rebound).
      this.elasticPhase = true;
      this.linkForce?.strength?.(() => 0.4);
      // After 1.5s, reset springs to 0 — cluster force fully reasserts.
      this.elasticTimer = setTimeout(() => {
        this.elasticPhase = false;
        this.elasticTimer = null;
        this.linkForce?.strength?.(() => 0);
        this.graph.d3ReheatSimulation();
      }, 1500);
      // Hot reheat so the rebound has energy to propagate.
      this.graph.d3ReheatSimulation();
    });
  }

  private applySize(): void {
    const w = this.opts.container.clientWidth;
    const h = this.opts.container.clientHeight;
    if (w > 0 && h > 0) {
      this.graph.width(w).height(h);
    }
  }

  setNodes(nodes: AtlasNode[], opts?: { pinExisting?: boolean }): void {
    this.allNodes = nodes.map((n) => ({ ...n }));
    // Clear any pending pin-release from a prior incremental add — this push
    // re-decides what's pinned.
    if (this.incrementalUnpinTimer !== null) {
      clearTimeout(this.incrementalUnpinTimer);
      this.incrementalUnpinTimer = null;
    }
    // Incremental ingest mode: pin nodes that already have a settled position
    // (carried via x/y/z) so the reheat below moves ONLY the new, position-less
    // nodes — a freshly ingested source spawns + settles in place while the
    // rest of the already-laid-out graph stays put. Released after a settle
    // window (below) so future layouts / drift still work.
    if (opts?.pinExisting) {
      for (const n of this.allNodes as Array<AtlasNode & { fx?: number | null; fy?: number | null; fz?: number | null; x?: number; y?: number; z?: number }>) {
        if (n.x !== undefined && n.y !== undefined && n.z !== undefined) {
          n.fx = n.x; n.fy = n.y; n.fz = n.z;
        }
      }
    }
    // Layout breathing room — scales link distance, repulsion strength,
    // and collision-bubble radius by sqrt(N/20).
    //   20 nodes  → ~1.0×
    //   50 nodes  → ~1.6×
    //   100 nodes → ~2.2×
    //   200 nodes → ~3.2×
    // More aggressive than the previous /30 divisor so dense local clusters
    // get noticeably more elbow room as the graph grows. Compact (Overview)
    // renderer caps lower so the mini-Atlas teaser doesn't sprawl outside
    // its 240px frame.
    const N = this.allNodes.length;
    const scale = Math.max(1, Math.sqrt(N / 20));
    this.layoutScale = this.opts.compact ? Math.min(scale, 1.4) : scale;
    // Scale simulation intensity with graph size so large graphs don't freeze
    // the main thread. Three tiers based on node count:
    //   small  (< 500)  : warmup=80, cooldown=300, alphaDecay=0.012, collideIter=3
    //   medium (< 2000) : warmup=20, cooldown=120, alphaDecay=0.020, collideIter=2
    //   large  (≥ 2000) : warmup=0,  cooldown=60,  alphaDecay=0.035, collideIter=1
    // warmupTicks runs synchronously before first render — keeping it at 0 for
    // large graphs eliminates the hard freeze on load; nodes start random and
    // settle visibly over a second or two instead.
    if (!this.opts.compact) {
      const [warmup, cooldown, alphaDecay, collideIter] =
        N < 500  ? [80, 300, 0.012, 3] :
        N < 2000 ? [20, 120, 0.020, 2] :
                   [0,   60, 0.035, 1];
      this.graph.warmupTicks(warmup);
      this.graph.cooldownTicks(cooldown);
      this.graph.d3AlphaDecay(alphaDecay);
      const collide = this.graph.d3Force('collide') as
        | undefined
        | { radius?: (fn: () => number) => unknown; iterations?: (n: number) => unknown };
      collide?.radius?.(() => globalThis.atlasPerf.collide ? 14 * this.layoutScale : 0);
      collide?.iterations?.(collideIter);
      this.applyChargeForce();
    }
    // Initialize source-visibility map (existing keys preserved, new ones default-on).
    // Also rebuild the nodeSourceFileMap for O(1) cross-file edge detection.
    const seen = new Set<string>();
    this.nodeSourceFileMap.clear();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      seen.add(key);
      if (!this.sourceVisible.has(key)) this.sourceVisible.set(key, true);
      this.nodeSourceFileMap.set(n.id, key);
    }
    // Drop sources that no longer exist.
    for (const key of [...this.sourceVisible.keys()]) {
      if (!seen.has(key)) this.sourceVisible.delete(key);
    }

    // ── Source-file cluster anchors ──────────────────────────────────────
    // Assign each source file a fixed 3D anchor on a ring so the cluster
    // force always has a stable target. Anchors are evenly spaced on a
    // torus-like ring so every file gets its own region of the galaxy.
    // Radius scales with layoutScale so more files = wider ring.
    if (!this.opts.compact) {
      const sourceKeys = [...new Set(this.allNodes.map((n) => n.sourceFile ?? ''))];
      // Only recompute cluster-ring positions when the SOURCE SET changes.
      // Re-running this on every incremental refresh (e.g. an MCP remember
      // adding one node) would shift every cluster's ring angle, making all
      // existing clusters teleport — the main visual cause of the blob collapse.
      const newKeyFingerprint = [...sourceKeys].sort().join('|');
      const oldKeyFingerprint = [...this.clusterCenters.keys()].sort().join('|');
      const sourcesChanged = newKeyFingerprint !== oldKeyFingerprint;
      if (sourcesChanged) {
        // Ring radius scaled up 3.3× from the old 150 so clusters sit far
        // enough apart to feel like distinct islands in space. TILT lifts
        // alternating clusters above/below the XZ plane so the layout has
        // real Z-depth — the user has to orbit the camera to see them all.
        const CLUSTER_R = 2000 * this.layoutScale;
        // Each cluster center gets a deterministic Y position drawn from a
        // seeded hash so the vertical spread is irregular (not just alternating
        // ±1) — this breaks the flat-ring appearance when there are many sources.
        this.clusterCenters.clear();
        sourceKeys.forEach((key, i) => {
          const angle = (i / sourceKeys.length) * 2 * Math.PI;
          // Y: a pseudo-random ±CLUSTER_R*1.6 scaled by hash so no two clusters
          // sit on the same horizontal plane. Range ≈ ±3200 units.
          const yHash = hashStrToFloat(key, 99);   // dedicated seed
          const yOffset = (yHash * 2 - 1) * CLUSTER_R * 1.6;
          this.clusterCenters.set(key, {
            x: Math.cos(angle) * CLUSTER_R,
            y: yOffset,
            z: Math.sin(angle) * CLUSTER_R,
          });
        });
      }
    }

    // Sub-anchors are computed in computeSubAnchors(), called from setEdges()
    // which runs right after setNodes() in pushDataIntoAtlas(). Clear them
    // here so the cluster force pulls toward cluster centers during the brief
    // window before setEdges() arrives.
    this.nodeSubAnchors.clear();
    // Only restart the explosion animation when new source files appear —
    // not on every incremental node add from an AI client. This prevents the
    // animation timer resetting mid-render every time the AI saves a memory.
    const newKeyFingerprint2 = [...new Set(this.allNodes.map((n) => n.sourceFile ?? ''))].sort().join('|');
    const oldKeyFingerprint2 = [...this.clusterCenters.keys()].sort().join('|');
    if (newKeyFingerprint2 !== oldKeyFingerprint2) this.explosionStartTime = Date.now();

    // ── Count truly-new nodes BEFORE seeding ─────────────────────────────
    // Nodes whose positions were carried forward from the previous render
    // (via getPositionMap() in main.ts) already have x/y/z set. Count those
    // that don't — they are genuinely new and need to be seeded.
    const newNodeCount = this.allNodes.filter(
      (n) => n.x === undefined || n.y === undefined || n.z === undefined,
    ).length;

    // ── Sphere seeding near cluster anchor ───────────────────────────────
    // New nodes start close to their cluster center so the explosion
    // animation is visible: they spread outward from near-zero offset.
    const localSeedR = 20 * this.layoutScale;
    for (const n of this.allNodes) {
      if (n.x === undefined || n.y === undefined || n.z === undefined) {
        const center = this.clusterCenters.get(n.sourceFile ?? '') ?? { x: 0, y: 0, z: 0 };
        let sx: number, sy: number, sz: number, r2: number;
        do {
          sx = (Math.random() - 0.5) * 2;
          sy = (Math.random() - 0.5) * 2;
          sz = (Math.random() - 0.5) * 2;
          r2 = sx * sx + sy * sy + sz * sz;
        } while (r2 > 1 || r2 < 0.01);
        const inv = 1 / Math.sqrt(r2);
        n.x = center.x + sx * inv * localSeedR;
        n.y = center.y + sy * inv * localSeedR;
        n.z = center.z + sz * inv * localSeedR;
      }
    }

    // ── Pulse phase / period ─────────────────────────────────────────────
    // Assign a random phase and period to each node that doesn't have one yet.
    // Existing nodes keep their phases so the oscillation is continuous across
    // data refreshes. Stale entries (nodes that no longer exist) are pruned.
    const newNodeIdSet = new Set(this.allNodes.map((n) => n.id));
    for (const n of this.allNodes) {
      if (!this.nodePulsePhase.has(n.id)) {
        this.nodePulsePhase.set(n.id, Math.random() * 2 * Math.PI);
        // Periods 2 – 5 s, uniformly random, so nodes are always at different
        // points in their cycle and the effect looks organic rather than uniform.
        this.nodePulsePeriod.set(n.id, 2000 + Math.random() * 3000);
      }
    }
    for (const id of [...this.nodePulsePhase.keys()]) {
      if (!newNodeIdSet.has(id)) {
        this.nodePulsePhase.delete(id);
        this.nodePulsePeriod.delete(id);
      }
    }

    this.refreshGraph();
    // Belt-and-suspenders: if the container had no dimensions when we
    // constructed (e.g., the pane was display:none) the library's internal
    // canvas can stay at 0×0. Re-apply size on every data swap so render
    // ticks always have correct WebGL viewport dimensions.
    this.applySize();
    // Always reheat the simulation after a data update. Now that positions are
    // carried forward via getPositionMap() → nodesToAtlas(), the reheat starts
    // from the well-spread current positions rather than near cluster centers,
    // so it converges back to a spread layout instead of collapsing into blobs.
    // The old "soft alpha bump" path caused the cluster force to run against
    // un-anchored nodes (sub-anchors are cleared above and not restored until
    // setEdges() runs) which pulled everything into tight cluster blobs.
    void newNodeCount; // still tracked for future use; not needed for branching
    this.graph.d3ReheatSimulation();
    // Incremental add: release the pins once the new source has settled, so the
    // graph isn't permanently frozen (alive drift + future layouts work again).
    if (opts?.pinExisting) {
      this.incrementalUnpinTimer = setTimeout(() => {
        this.incrementalUnpinTimer = null;
        for (const n of this.graph.graphData().nodes as Array<{ fx?: number | null; fy?: number | null; fz?: number | null }>) {
          n.fx = null; n.fy = null; n.fz = null;
        }
      }, INCREMENTAL_UNPIN_MS);
    }
    // STAGE A (task #42): (re)build the instanced Points node layer alongside
    // the library spheres. Positions are 0 here and snap into place once the
    // sim assigns x/y/z — syncNodePointsFrame() copies them every frame.
    if (this.nodePointsEnabled) {
      try { this.rebuildNodePointsLayer(); }
      catch (e) {
        console.error('[atlas] node-points rebuild failed — disabling layer:', e);
        this.nodePointsEnabled = false;
        this.teardownNodePointsLayer();
      }
    }
  }

  // ── Instanced node layer (THREE.Points) — task #42, Stage A ───────────────

  /** Base point size (world radius) mirroring the library sphere:
   *  nodeRelSize(49.5) × ∛(nodeVal), including the selected/preview/drag boosts. */
  private nodePointSize(n: AtlasNode): number {
    const confidencePart = 0.6 + n.confidence * 1.2;
    const degree = this.nodeDegree.get(n.id) ?? 0;
    let base = confidencePart + Math.sqrt(degree) * 0.55;
    if (n.id === this.selectedId)         base *= 2.5;
    if (this.previewHighlightId === n.id) base *= 1.7;
    if (this.draggingId === n.id)         base *= 1.5;
    return 49.5 * Math.cbrt(base);
  }

  /** Parse colorForNode()'s output ("rgba(r,g,b,a)" / "rgb(...)" / hex) into
   *  normalized RGB + alpha for the attribute buffers. */
  private parseColorString(s: string): { r: number; g: number; b: number; a: number } {
    const m = s.match(/rgba?\(([^)]+)\)/i);
    if (m && m[1]) {
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      return { r: (p[0] ?? 255) / 255, g: (p[1] ?? 255) / 255, b: (p[2] ?? 255) / 255, a: p[3] ?? 1 };
    }
    const c = new THREE.Color(s);
    return { r: c.r, g: c.g, b: c.b, a: 1 };
  }

  /** Write per-node colour/alpha/size into the buffers (call on colour-cache
   *  invalidation — selection, hover, legend dim, drag). Positions + pulse are
   *  handled per-frame in syncNodePointsFrame(). */
  private updateNodePointsAttributes(): void {
    const geom = this.nodePointsGeom;
    if (!geom) return;
    const colors = (geom.getAttribute('aColor') as THREE.BufferAttribute).array as Float32Array;
    const alpha = (geom.getAttribute('aAlpha') as THREE.BufferAttribute).array as Float32Array;
    const size = (geom.getAttribute('aSize') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < this.allNodes.length; i++) {
      const node = this.allNodes[i]!;
      const col = this.parseColorString(this.colorForNode(node));
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
      alpha[i] = col.a * 0.92; // match the spheres' global nodeOpacity(0.92)
      size[i] = this.nodePointSize(node);
    }
    (geom.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }

  private teardownNodePointsLayer(): void {
    const scene = (this.graph as unknown as { scene?: () => THREE.Scene | undefined }).scene?.();
    if (this.nodePoints) {
      scene?.remove(this.nodePoints);
      this.nodePointsGeom?.dispose();
      (this.nodePoints.material as THREE.Material).dispose();
    }
    this.nodePoints = null;
    this.nodePointsGeom = null;
  }

  private rebuildNodePointsLayer(): void {
    this.teardownNodePointsLayer();
    const scene = (this.graph as unknown as { scene?: () => THREE.Scene | undefined }).scene?.();
    if (!this.nodePointsEnabled || !scene) return;
    const n = this.allNodes.length;
    if (n === 0) return;
    this.nodePointIndex.clear();
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const size = new Float32Array(n);
    const pulse = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.nodePointIndex.set(this.allNodes[i]!.id, i);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geom.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geom.setAttribute('aPulse', new THREE.BufferAttribute(pulse, 1));
    // Huge bounding sphere so the whole cloud is never frustum-culled as one.
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 aColor; attribute float aAlpha; attribute float aSize; attribute float aPulse;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, aSize * aPulse * uScale / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        precision mediump float;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = dot(c, c);
          if (d > 0.25) discard;             // circular sprite
          float edge = smoothstep(0.25, 0.16, d);
          gl_FragColor = vec4(vColor, vAlpha * edge);
        }`,
    });
    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.renderOrder = 1;
    scene.add(points);
    this.nodePoints = points;
    this.nodePointsGeom = geom;
    this.updateNodePointsAttributes();
  }

  /** Per-frame: copy node positions from the sim + recompute pulsation into the
   *  Points buffers, and keep the perspective size uniform current. */
  private syncNodePointsFrame(now: number): void {
    const geom = this.nodePointsGeom;
    if (!this.nodePoints || !geom) return;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const pulseAttr = geom.getAttribute('aPulse') as THREE.BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const pulse = pulseAttr.array as Float32Array;
    const nodes = this.graph.graphData().nodes as Array<{ id?: string; x?: number; y?: number; z?: number }>;
    const amp = this.brainVitality / 100;
    for (const nd of nodes) {
      const idx = this.nodePointIndex.get(nd.id ?? '');
      if (idx === undefined) continue;
      pos[idx * 3] = nd.x ?? 0; pos[idx * 3 + 1] = nd.y ?? 0; pos[idx * 3 + 2] = nd.z ?? 0;
      if (this.aliveEnabled) {
        const phase = this.nodePulsePhase.get(nd.id ?? '') ?? 0;
        const period = this.nodePulsePeriod.get(nd.id ?? '') ?? 3000;
        pulse[idx] = 1 + amp * (Math.sin(phase + PI2 * now / period) + 1) / 2;
      } else {
        pulse[idx] = 1;
      }
    }
    posAttr.needsUpdate = true;
    pulseAttr.needsUpdate = true;
    const cam = this.graph.camera() as THREE.PerspectiveCamera | null;
    const mat = this.nodePoints.material as THREE.ShaderMaterial;
    if (cam && mat.uniforms?.uScale) {
      const h = this.opts.container.clientHeight || 1;
      mat.uniforms.uScale.value = h / Math.tan((cam.fov * Math.PI / 180) / 2);
    }
  }

  setEdges(directed: AtlasDirectedEdge[], undirected: AtlasUndirectedEdge[]): void {
    const validIds = new Set(this.allNodes.map((n) => n.id));
    const out: AtlasLink[] = [];
    for (const d of directed) {
      if (!validIds.has(d.from) || !validIds.has(d.to)) continue;
      out.push({
        id: `d:${d.id}`,
        source: d.from,
        target: d.to,
        directed: true,
        type: d.type,
        category: categoryFor(true, d.type),
        weight: d.weight,
        ...(d.evidence !== undefined ? { evidence: d.evidence } : {}),
      });
    }
    for (const u of undirected) {
      if (!validIds.has(u.a) || !validIds.has(u.b)) continue;
      out.push({
        id: `u:${u.id}`,
        source: u.a,
        target: u.b,
        directed: false,
        type: u.type,
        category: categoryFor(false, u.type),
        weight: u.weight,
      });
    }
    this.realLinks = out;
    this.rebuildAllLinks();
  }

  /**
   * Replace the GNN-predicted overlay layer. Predicted edges live in the
   * separate `.gnn` overlay, never in the `.gai` graph — here they render
   * as a distinct, dashed, toggleable category so a model prediction is
   * never mistaken for a deterministic connection. No-op while the layer
   * is and stays empty (the common, neural-network-disabled case).
   */
  setPredictedEdges(predicted: AtlasPredictedEdge[]): void {
    if (predicted.length === 0 && this.predictedLinks.length === 0) return;
    // Skip the rebuild when the overlay is unchanged — pushDataIntoAtlas can
    // fire often, but predictions only change on a neural-network run.
    if (predicted.length === this.predictedLinks.length) {
      let same = true;
      for (let i = 0; i < predicted.length; i++) {
        const a = predicted[i]!;
        const b = this.predictedLinks[i]!;
        if (`p:${a.id}` !== b.id || a.score !== b.weight) { same = false; break; }
      }
      if (same) return;
    }
    // Defensive: drop predicted edges whose endpoint nodes either don't exist
    // OR don't yet have a usable 3D position. d3-force assigns x/y/z over
    // ticks; a freshly-loaded engram + a stale .gnn overlay referencing
    // never-positioned (e.g. soft-deleted) nodes would render as lines
    // flying off to screen corners — the symptom we hit when nodes the
    // GNN predicted edges to had been forgotten via `forget` / `forgetSource`
    // without the overlay being pruned. Real fix lives at the overlay-prune
    // layer; this is the renderer's belt-and-suspenders.
    const positionedById = new Map<string, AtlasNode>();
    for (const n of this.allNodes) {
      const x = (n as { x?: number }).x;
      const y = (n as { y?: number }).y;
      const z = (n as { z?: number }).z;
      // d3-force assigns x/y/z to finite numbers after the first tick. Until
      // then they're undefined (or NaN if a calc failed). Either way we
      // skip — better to hide the edge than draw it at origin/infinity.
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        positionedById.set(n.id, n);
      }
    }
    const out: AtlasLink[] = [];
    let droppedNoPosition = 0;
    for (const p of predicted) {
      if (!positionedById.has(p.from) || !positionedById.has(p.to)) {
        droppedNoPosition += 1;
        continue;
      }
      out.push({
        id: `p:${p.id}`,
        source: p.from,
        target: p.to,
        directed: false,
        type: 'related-to',
        category: 'predicted',
        weight: p.score,
      });
    }
    if (droppedNoPosition > 0) {
      console.warn(`[atlas] dropped ${droppedNoPosition} predicted edge(s) with unpositioned endpoints — likely stale .gnn overlay entries for soft-deleted nodes`);
    }
    // Stale line handles — the new AtlasLink objects are fresh references, so
    // linkThreeObject re-fires for every predicted edge and repopulates this.
    this.predictedLineObjs.clear();
    this.predictedLinks = out;
    this.rebuildAllLinks();
  }

  /**
   * Merge the real (`.gai`) and predicted (`.gnn`) link layers, recompute
   * derived geometry, and refresh the renderer. Shared tail of setEdges()
   * and setPredictedEdges().
   */
  private rebuildAllLinks(): void {
    // d3-force only re-resolves a link endpoint that is still a string id; a
    // link object reused across a setNodes() (the predicted overlay survives
    // the early-return in setPredictedEdges) keeps a stale node-object ref and
    // renders detached from the fresh nodes. Normalize every endpoint back to
    // its id so d3 re-resolves it, and drop links whose endpoints no longer
    // exist (e.g. a stale predicted overlay lingering after a graph switch).
    const validIds = new Set(this.allNodes.map((n) => n.id));

    // True per-category counts from the FULL real-link set — for the legend.
    this.categoryEdgeCounts.clear();
    for (const l of this.realLinks) {
      this.categoryEdgeCounts.set(l.category, (this.categoryEdgeCounts.get(l.category) ?? 0) + 1);
    }

    // Sample dense categories to EDGE_SAMPLE_CAP (strongest by weight) instead
    // of hard-hiding them — this caps the render AND the sim/visibility cost.
    const sampledReal = this.sampleLinksByCategory(this.realLinks);

    const merged: AtlasLink[] = [];
    for (const l of [...sampledReal, ...this.predictedLinks]) {
      const s = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      if (!validIds.has(s) || !validIds.has(t)) continue;
      l.source = s;
      l.target = t;
      merged.push(l);
    }
    this.allLinks = merged;
    this.computeEdgeShapes();
    this.computeNodeDegrees(); // reads realLinks (full) so sizes reflect true connectivity
    this.computeSubAnchors(); // needs both allNodes + allLinks — called here

    this.refreshGraph();
  }

  /** Per category: keep all links if under EDGE_SAMPLE_CAP, else the strongest
   *  EDGE_SAMPLE_CAP by weight (deterministic — stable across rebuilds, no
   *  flicker). Records which categories were sampled for the legend note. */
  private sampleLinksByCategory(links: AtlasLink[]): AtlasLink[] {
    const byCat = new Map<EdgeCategory, AtlasLink[]>();
    for (const l of links) {
      const arr = byCat.get(l.category);
      if (arr) arr.push(l); else byCat.set(l.category, [l]);
    }
    this.sampledCategories.clear();
    const out: AtlasLink[] = [];
    for (const [cat, arr] of byCat) {
      if (arr.length <= EDGE_SAMPLE_CAP) { out.push(...arr); continue; }
      const sorted = [...arr].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      for (let i = 0; i < EDGE_SAMPLE_CAP; i++) out.push(sorted[i]!);
      this.sampledCategories.add(cat);
    }
    return out;
  }

  /**
   * Compute per-node sub-anchor positions for the cluster explosion.
   * Must run after BOTH setNodes() (for clusterCenters + nodeSourceFileMap)
   * and setEdges() (for cross-cluster affinity → tendril shifts).
   *
   * Each node gets a unique point on an anisotropically-deformed Fibonacci
   * sphere around its cluster center.  Nodes with strong cross-cluster edge
   * weight have their sub-anchor shifted toward the dominant neighbor cluster
   * (max 30% of the inter-cluster gap) — this creates visible "tendrils"
   * reaching between blobs without them fully intersecting.
   */
  private computeSubAnchors(): void {
    if (this.opts.compact) return;

    // ── Step 1: base Fibonacci positions + per-source anisotropy ──────────
    const nodesBySource = new Map<string, AtlasNode[]>();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      const arr = nodesBySource.get(key) ?? [];
      arr.push(n);
      nodesBySource.set(key, arr);
    }
    this.nodeSubAnchors.clear();
    for (const [key, nodes] of nodesBySource) {
      const center = this.clusterCenters.get(key);
      if (!center) continue;
      const N = nodes.length;
      // Per-source anisotropy — all three axes have the same range so no
      // axis is forced flat. Each source gets an independent stretch on
      // X, Y and Z (0.5 – 2.5): some clusters become vertical cigars,
      // some horizontal slabs, some lumpy blobs — all in true 3D.
      const ax = 0.5 + hashStrToFloat(key, 1) * 2.0;
      const ay = 0.5 + hashStrToFloat(key, 2) * 2.0; // same range as x/z
      const az = 0.5 + hashStrToFloat(key, 3) * 2.0;

      // Random rotation (two independent Euler angles) so elongation axes
      // point in arbitrary 3D directions — not just along world X/Z.
      // Without rotation every stretched cluster aligns with the world grid,
      // which reads as 2D even when Y is included.
      const rotA = hashStrToFloat(key, 4) * Math.PI * 2; // rotation around Y axis
      const rotB = hashStrToFloat(key, 5) * Math.PI;     // tilt around X axis
      const cosA = Math.cos(rotA), sinA = Math.sin(rotA);
      const cosB = Math.cos(rotB), sinB = Math.sin(rotB);

      // Radius: larger clusters spread much wider. The generous multiplier
      // ensures even small sources (N=5) get a clearly visible 3D shape,
      // while big ones fill their region of the galaxy.
      const baseR = (220 + 280 * Math.sqrt(N / 40)) * this.layoutScale;

      nodes.forEach((n, i) => {
        const [fx, fy, fz] = fibonacciSpherePoint(i, N);

        // Apply anisotropic stretch in local space.
        let px = fx * ax;
        let py = fy * ay;
        let pz = fz * az;

        // Rotate around X axis (tilt).
        const py1 = py * cosB - pz * sinB;
        const pz1 = py * sinB + pz * cosB;
        py = py1; pz = pz1;

        // Rotate around Y axis (spin).
        const px2 = px * cosA + pz * sinA;
        const pz2 = -px * sinA + pz * cosA;
        px = px2; pz = pz2;

        // ±20% positional jitter so the lattice regularity isn't visible
        // on small clusters where Fibonacci points are far apart.
        const jitter = baseR * 0.20;
        const jx = (Math.random() - 0.5) * jitter;
        const jy = (Math.random() - 0.5) * jitter;
        const jz = (Math.random() - 0.5) * jitter;

        this.nodeSubAnchors.set(n.id, {
          x: center.x + px * baseR + jx,
          y: center.y + py * baseR + jy,
          z: center.z + pz * baseR + jz,
        });
      });
    }

    // ── Step 2: cross-cluster affinity → tendril shift ────────────────────
    // For each node, sum the edge weights going to each other source file.
    // The dominant cross-cluster connection pulls the sub-anchor toward
    // that cluster's center by up to 30% of the inter-center distance.
    // The 30% cap guarantees tendrils never cross the midpoint between
    // any two clusters — blobs stay visually distinct.
    if (this.allLinks.length === 0) return;

    // Accumulate cross-cluster weight per (nodeId, targetSourceFile) pair.
    const crossAffinity = new Map<string, Map<string, number>>();
    for (const l of this.allLinks) {
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      const sFile = this.nodeSourceFileMap.get(sId) ?? '';
      const tFile = this.nodeSourceFileMap.get(tId) ?? '';
      if (sFile === tFile) continue; // same-source edges don't create affinity

      const addAff = (nodeId: string, targetFile: string, w: number): void => {
        const m = crossAffinity.get(nodeId) ?? new Map<string, number>();
        m.set(targetFile, (m.get(targetFile) ?? 0) + w);
        crossAffinity.set(nodeId, m);
      };
      addAff(sId, tFile, l.weight);
      addAff(tId, sFile, l.weight);
    }

    // Apply shift toward dominant neighbor cluster.
    for (const [nodeId, affinities] of crossAffinity) {
      let bestFile = '';
      let bestWeight = 0;
      for (const [file, w] of affinities) {
        if (w > bestWeight) { bestWeight = w; bestFile = file; }
      }
      // Skip nodes with negligible cross-cluster connections — don't shift
      // every semantic co-occurrence, only meaningfully connected ones.
      if (!bestFile || bestWeight < 0.5) continue;

      const sub = this.nodeSubAnchors.get(nodeId);
      const myFile = this.nodeSourceFileMap.get(nodeId) ?? '';
      const myCenter = this.clusterCenters.get(myFile);
      const targetCenter = this.clusterCenters.get(bestFile);
      if (!sub || !myCenter || !targetCenter) continue;

      // Fraction scales with connection strength but is hard-capped at 30%
      // of the inter-cluster vector so tendrils never reach the midpoint.
      // Saturates at ~4 units of weight (≈ 4-6 temporal/structural edges).
      const fraction = Math.min(0.30, (bestWeight / 4.0) * 0.32);
      sub.x += (targetCenter.x - myCenter.x) * fraction;
      sub.y += (targetCenter.y - myCenter.y) * fraction;
      sub.z += (targetCenter.z - myCenter.z) * fraction;
    }

    // ── Step 3: pre-position nodes at sub-anchors ────────────────────────
    // The physics simulation starts from wherever setNodes() placed nodes
    // (cluster center ± small jitter). The link force and charge force easily
    // overpower the cluster force before the explosion animation reaches full
    // progress, collapsing blobs back toward a flat 2D plane.
    // Fix: snap all nodes to their computed sub-anchor positions RIGHT NOW
    // so the simulation starts already in 3D. The cluster force then only
    // needs to maintain the spread, not fight its way there.
    for (const n of this.allNodes) {
      const sub = this.nodeSubAnchors.get(n.id);
      if (sub) { n.x = sub.x; n.y = sub.y; n.z = sub.z; }
    }

    // Reset explosion timer so the animation plays from scratch
    // every time edges are re-loaded (graph switch, reingest, etc.).
    this.explosionStartTime = Date.now();
  }

  /**
   * Aggregate incident edge weights per node. Both endpoints of every link
   * accumulate the link's weight — undirected and directed contribute
   * equally. The result drives node size in `nodeVal`.
   */
  private computeNodeDegrees(): void {
    this.nodeDegree.clear();
    // Read the FULL real-link set (not the sampled working set) so node sizes
    // reflect true connectivity even when dense categories are sampled down.
    for (const l of this.realLinks) {
      if (l.category === 'predicted') continue; // node size reflects real connectivity only
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      this.nodeDegree.set(sId, (this.nodeDegree.get(sId) ?? 0) + l.weight);
      this.nodeDegree.set(tId, (this.nodeDegree.get(tId) ?? 0) + l.weight);
    }
  }

  /**
   * Bucket edges by unordered node-pair, then assign each a distinct
   * (curvature, rotation) so:
   *   - A single edge gets a gentle baseline curve (organic feel).
   *   - N edges between the same pair get curvatures spread around 0 and
   *     rotations spread around the source-target axis — like a small
   *     bundle of fibers connecting two neurons. Directed-and-undirected
   *     between the same pair stay visually distinct because the arrow
   *     particle moves along one of them, and they curve in different
   *     directions.
   *
   * The pair key is unordered so a directed edge A→B and an undirected
   * A↔B share a bucket — they should still be visually separated.
   */
  /**
   * Assign curvature only to undirected edges that share a node pair with
   * at least one directed edge. Rules:
   *
   *   - Directed edges → always curvature 0. Their flowing particle
   *     animations already distinguish them visually; adding a curve
   *     would make the particle path look wrong and adds Bezier cost.
   *
   *   - Undirected edges WITHOUT a directed partner → curvature 0.
   *     There is nothing to visually separate them from, so a curve
   *     adds no information and costs Bezier rebuilds.
   *
   *   - Undirected edges WITH a directed partner → curvature 0.35,
   *     rotation 90° off the directed line (or evenly fanned for
   *     multiple undirected edges in the same bucket). This makes the
   *     arc visibly separate from the straight arrow, so the user can
   *     tell "there is both a causal link AND a semantic similarity
   *     here" at a glance.
   *
   * The set of co-parallel pairs is usually small (<10% of all edges
   * in typical engrams), so Bezier rebuild cost is minimal even during
   * active physics.
   */
  private computeEdgeShapes(): void {
    this.edgeShape.clear();

    // Bucket all edges by unordered node pair.
    const buckets = new Map<string, AtlasLink[]>();
    for (const l of this.allLinks) {
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      const key = sId < tId ? `${sId}|${tId}` : `${tId}|${sId}`;
      const arr = buckets.get(key);
      if (arr) arr.push(l);
      else buckets.set(key, [l]);
    }

    const CURVE_PARALLEL = 0.35; // bow magnitude for co-parallel undirected edges

    for (const arr of buckets.values()) {
      const hasDirected   = arr.some(l =>  l.directed);
      const hasUndirected = arr.some(l => !l.directed);
      const coParallel    = hasDirected && hasUndirected;

      if (!coParallel) {
        // Pure-directed or pure-undirected: everything straight.
        for (const l of arr) this.edgeShape.set(l.id, { curvature: 0, rotation: 0 });
        continue;
      }

      // Co-parallel bucket: directed edges stay at 0; undirected edges
      // curve away from them. Multiple undirected edges in the same
      // bucket are fanned evenly around the source-target axis so they
      // each read as a distinct arc.
      const undirected = arr.filter(l => !l.directed).sort((a, b) => a.id.localeCompare(b.id));
      const n = undirected.length;

      for (const l of arr) {
        if (l.directed) {
          this.edgeShape.set(l.id, { curvature: 0, rotation: 0 });
        } else {
          const idx = undirected.indexOf(l);
          // Spread around 90° from the directed "straight lane" so none of
          // the arcs overlap each other or the arrow line.
          const rotation = n === 1
            ? Math.PI / 2                              // single arc: 90° off
            : (Math.PI / 2) + (idx / n) * Math.PI;   // multiple arcs: fan from 90° to 270°
          this.edgeShape.set(l.id, { curvature: CURVE_PARALLEL, rotation });
        }
      }
    }
  }

  /**
   * Precompute which node/link IDs pass the current source + category
   * filters. The result is stored in `visibleNodeIds` / `visibleLinkIds`
   * and read by the `nodeVisibility` / `linkVisibility` callbacks that
   * were registered on the graph in configureRenderer().
   *
   * Filter logic (same as before, now separated from graphData):
   *  1. Source filter: nodes whose sourceFile is visible.
   *  2. Category filter: edges whose category is on AND both endpoints
   *     survived step 1.
   *  3. When any category is hidden, also hide nodes with NO surviving
   *     edges — "show Social only" shouldn't leave 2000 orphan dots.
   *     When ALL categories are on, orphan nodes stay visible.
   */
  private computeVisibility(): void {
    const nodeId = (l: AtlasLink, end: 'source' | 'target'): string =>
      typeof l[end] === 'string' ? l[end] as string : (l[end] as AtlasNode).id;

    const srcVisibleNodes = this.allNodes.filter(
      (n) => this.sourceVisible.get(n.sourceFile ?? '') ?? true,
    );
    const srcVisibleIds = new Set(srcVisibleNodes.map((n) => n.id));

    const candidateLinks = this.allLinks.filter(
      (l) =>
        srcVisibleIds.has(nodeId(l, 'source')) &&
        srcVisibleIds.has(nodeId(l, 'target')) &&
        this.categoryVisible[l.category],
    );

    // 'predicted' is always off by default (it's an overlay, not a real edge
    // category) — exclude it from the "any category hidden?" check so it doesn't
    // permanently activate the "only show connected nodes" path. Without this,
    // engrams with zero real edges (e.g. a fresh 2-node engram like FORA) show
    // no nodes at all because connectedIds is empty when there are no edges.
    const REAL_EDGE_CATEGORIES: EdgeCategory[] = ['reasoning', 'structure', 'social', 'temporal', 'semantic', 'identity'];
    // Only the USER manually hiding a category triggers the "show only connected
    // nodes" path. A category that's hidden because it's HARD-LOCKED (too dense
    // to render) was not the user's choice — hiding the ~80% of nodes wired only
    // by it (as happened on large graphs) is surprising. Exclude hard-locked
    // categories so those nodes stay visible.
    const anyCategoryHidden = REAL_EDGE_CATEGORIES.some(
      (cat) => !this.categoryVisible[cat] && !this.isCategoryHardLocked(cat),
    );
    if (anyCategoryHidden) {
      const connectedIds = new Set<string>();
      for (const l of candidateLinks) {
        connectedIds.add(nodeId(l, 'source'));
        connectedIds.add(nodeId(l, 'target'));
      }
      // Always include orphan nodes (nodes with no edges at all in the real graph).
      // Without this, a node that has ZERO real connections disappears when any
      // edge category is hidden — even if it belongs to a fully visible source.
      const hasAnyRealEdge = new Set<string>();
      for (const l of this.realLinks) {
        hasAnyRealEdge.add(typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id);
        hasAnyRealEdge.add(typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id);
      }
      for (const n of srcVisibleNodes) {
        if (!hasAnyRealEdge.has(n.id)) connectedIds.add(n.id); // true orphan — always show
      }
      this.visibleNodeIds = connectedIds;
    } else {
      this.visibleNodeIds = srcVisibleIds;
    }
    this.visibleLinkIds = new Set(candidateLinks.map((l) => l.id));
  }

  /**
   * Push ALL nodes/links into the graph and recompute visibility.
   * Only called when the underlying data changes (setNodes / setEdges).
   * Filter-only changes go through applyVisibilityFilter() instead,
   * which never restarts the physics simulation.
   */
  private refreshGraph(): void {
    this.computeVisibility();
    this.graph.graphData({ nodes: this.allNodes, links: this.allLinks });
  }

  /** Frame the camera so the full cloud fits in view.
   *  After centering, shifts the view right to account for the legend
   *  panel that overlays the left side of the canvas. */
  zoomToFit(ms = 800, padding = 80): void {
    if (this.opts.compact) {
      this.graph.zoomToFit(ms, padding);
      return;
    }

    const cam = this.graph.camera() as THREE.PerspectiveCamera;
    if (!cam) { this.graph.zoomToFit(ms, padding); return; }

    // Compute bounding sphere of visible nodes.
    const nodes = this.allNodes.filter((n) => n.x !== undefined && this.visibleNodeIds.has(n.id));
    if (nodes.length === 0) { this.graph.zoomToFit(ms, padding); return; }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!);
      minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
      minZ = Math.min(minZ, n.z!); maxZ = Math.max(maxZ, n.z!);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    let maxR = 1;
    for (const n of nodes) {
      const dx = n.x! - cx, dy = n.y! - cy, dz = n.z! - cz;
      maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    const radius = maxR + padding;

    const rect = this.opts.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { this.graph.zoomToFit(ms, padding); return; }

    const fovRad = ((cam.fov ?? 75) * Math.PI) / 180;
    const halfFovV = fovRad / 2;
    const tanHalfV = Math.tan(halfFovV);

    // The atlas legend sits at left:12px, width:200px → occupies 212px.
    // Use the VISIBLE canvas width (right of the legend) for the horizontal
    // FOV calculation so the graph fits entirely in the open area, not behind
    // the overlay. Clamp so we don't blow up on pathologically narrow windows.
    // On mobile the legend is hidden, so there's no need to reserve space for
    // it or shift the graph right — centre in the full canvas instead.
    const legendVisible = typeof window === 'undefined' || window.innerWidth > 768;
    const LEGEND_PX = legendVisible ? 212 : 0; // legend left(12) + width(200)
    const visibleW  = Math.max(rect.width - LEGEND_PX, rect.width * 0.3);
    const halfFovH  = Math.atan(tanHalfV * visibleW / rect.height);

    // Distance that fits the bounding sphere in the visible area.
    const camDist = Math.max(radius / tanHalfV, radius / Math.tan(halfFovH), 100);

    // Preserve current orbit angle; back up along the view direction.
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const graphCenter = new THREE.Vector3(cx, cy, cz);
    const camPos      = graphCenter.clone().sub(fwd.clone().multiplyScalar(camDist));

    // TrackballControls calls cam.lookAt(target) every frame, so whatever
    // we pass as the lookAt argument becomes the rendered image centre.
    // To make the graph centre appear at the middle of the VISIBLE area
    // (right of the legend) rather than the raw canvas centre, we shift
    // the lookAt target LEFT by 106 px worth of world units.  TC then
    // aims slightly left; the graph centre projects 106 px to the right
    // of the image centre — exactly at the visible-area centre.
    const unitsPerPx  = (2 * tanHalfV * camDist) / rect.height;
    const worldShift  = (LEGEND_PX / 2) * unitsPerPx;          // 106 px → world
    const right       = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const lookAt      = graphCenter.clone().addScaledVector(right, -worldShift);

    // Single smooth animation.
    this.graph.cameraPosition(
      { x: camPos.x,  y: camPos.y,  z: camPos.z  },
      { x: lookAt.x,  y: lookAt.y,  z: lookAt.z  },
      ms,
    );
  }

  // ── Filters (UI calls these from the legend) ─────────────────────────

  /** Hard-locking is deprecated — dense categories are now SAMPLED to
   *  EDGE_SAMPLE_CAP and shown, not hidden — so nothing is hard-locked. Kept as
   *  a stable always-false seam for the call sites that still reference it. */
  isCategoryHardLocked(_category: EdgeCategory): boolean {
    return false;
  }

  /** Whether a category's edges were sampled down (rendered count < true
   *  count) — for the legend's "N shown" note. */
  isCategorySampled(category: EdgeCategory): boolean {
    return this.sampledCategories.has(category);
  }

  setCategoryVisible(category: EdgeCategory, visible: boolean): void {
    if (visible && this.isCategoryHardLocked(category)) return; // silently enforce lock
    this.categoryVisible[category] = visible;
    // Recompute visibility sets and redraw — do NOT call graphData or
    // reheat the simulation so node positions are preserved in place.
    this.computeVisibility();
    this.graph.refresh();
  }
  getCategoryVisibility(): Record<EdgeCategory, boolean> { return { ...this.categoryVisible }; }

  setSourceVisible(sourceKey: string, visible: boolean): void {
    this.sourceVisible.set(sourceKey, visible);
    // Same: visibility-only update, positions never change.
    this.computeVisibility();
    this.graph.refresh();
  }
  /**
   * Schedule a single `graph.refresh()` on the next animation frame.
   * Multiple calls within the same frame collapse into one repaint —
   * safe for rapid mouseenter/mouseleave bursts and Cmd+Tab focus cycles.
   */
  private scheduleRefresh(): void {
    if (this.pendingRefresh) return;
    this.pendingRefresh = true;
    requestAnimationFrame(() => {
      this.pendingRefresh = false;
      this.graph.refresh();
    });
  }

  /** Suppress (or restore) the node hover tooltip. Used by Presentation Mode so
   *  hovering a node can't leak its raw text past the redaction bars. */
  setHoverSuppressed(suppressed: boolean): void {
    this.hoverSuppressed = suppressed;
    if (suppressed && this.nodeTipEl) {
      this.nodeTipEl.style.display = 'none';
      this.nodeTipText = null;
    }
  }

  /**
   * Called on mouseenter/mouseleave of a legend category row.
   * Null clears the preview and restores normal rendering.
   */
  hoverCategory(cat: EdgeCategory | null): void {
    if (cat !== null && this.isCategoryHardLocked(cat)) return; // hard-locked — no hover effect
    if (this.previewLegendCategory === cat) return;
    this.previewLegendCategory = cat;
    this.previewLegendSource = null;
    // Pre-compute which nodes have at least one link of this category so
    // the per-node color callback is O(1) per call.
    this.previewCatNodeIds.clear();
    if (cat !== null) {
      const nodeId = (l: AtlasLink, end: 'source' | 'target'): string =>
        typeof l[end] === 'string' ? l[end] as string : (l[end] as AtlasNode).id;
      for (const l of this.allLinks) {
        if (l.category === cat) {
          this.previewCatNodeIds.add(nodeId(l, 'source'));
          this.previewCatNodeIds.add(nodeId(l, 'target'));
        }
      }
    }
    this.nodeColorCache.clear();
    this.linkColorCache.clear();
    this.particleColorCache.clear();
    this.particleCountCache.clear();
    this.scheduleRefresh();
  }

  /**
   * Called on mouseenter/mouseleave of a legend source row.
   * Null clears the preview and restores normal rendering.
   */
  hoverSource(key: string | null): void {
    if (this.previewLegendSource === key) return;
    this.previewLegendSource = key;
    this.previewLegendCategory = null;
    this.previewCatNodeIds.clear();
    this.nodeColorCache.clear();
    this.linkColorCache.clear();
    this.particleColorCache.clear();
    this.particleCountCache.clear();
    this.scheduleRefresh();
  }

  /** Returns each source with stable color + counts for legend rendering. */
  sourcesWithCounts(): Array<{ key: string; label: string; color: number; nodeCount: number; visible: boolean }> {
    const counts = new Map<string, number>();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([key, count]) => ({
        key,
        label: key ? labelForSourceKey(key) : '(no source)',
        color: colorForSource(key || undefined),
        nodeCount: count,
        visible: this.sourceVisible.get(key) ?? true,
      }));
  }

  edgeCounts(): Record<EdgeCategory, number> {
    const out: Record<EdgeCategory, number> = {
      reasoning: 0, structure: 0, social: 0, temporal: 0, semantic: 0, identity: 0, predicted: 0,
    };
    // TRUE counts from realLinks (+ predicted), NOT the sampled working set
    // (allLinks) — otherwise a sampled category reports its cap (5,000) as its
    // total. The legend pairs this with isCategorySampled() to show "5k / N".
    for (const l of this.realLinks) out[l.category] += 1;
    for (const l of this.predictedLinks) out[l.category] += 1;
    return out;
  }

  // ── Focus + neighbor walk ────────────────────────────────────────────

  /**
   * Select a node without moving the camera. Use this when the user is
   * navigating relationships via the inspector sidebar — switching the
   * selection on every click without yanking the viewport around.
   *
   * The orbit pivot does NOT move on selection (see onNodeClick comment).
   * It snaps to the selected node lazily, at the start of the user's
   * next orbit gesture, so clicks never produce a visible camera swing.
   */
  select(nodeId: string): void {
    const node = this.allNodes.find((n) => n.id === nodeId);
    if (!node) return;
    this.selectedId = nodeId;
    this.restylePredictedEdges();
    this.setOrbitPivotTo(node);
    // Maximise opacity so incident edges and the node itself render at
    // 100% regardless of the global link/node opacity multipliers.
    this.graph.linkOpacity(1.0);
    this.graph.nodeOpacity(1.0);
    this.graph.refresh();
  }

  /**
   * Move the trackball's orbit center (controls.target) to a node's
   * current position. Subsequent mouse-drag rotations pivot around this
   * point instead of the world origin — selection makes the camera feel
   * anchored to whatever the user is examining. Snapshot semantics: the
   * pivot stays where the node WAS at selection time, even if physics
   * later moves the node. Stable pivot beats a wobbly chase-cam.
   */
  private setOrbitPivotTo(node: AtlasNode): void {
    const ctrls = this.graph.controls() as
      | { target?: THREE.Vector3; update?: () => void }
      | undefined;
    if (!ctrls?.target) return;

    const cam = this.graph.camera() as THREE.PerspectiveCamera;
    if (!cam) return;

    const nodePos = new THREE.Vector3(node.x ?? 0, node.y ?? 0, node.z ?? 0);

    // TrackballControls calls camera.lookAt(target) on every update() tick
    // (see line 354 of TrackballControls.js). If we set target = node.position
    // directly, the camera swings to look at the node on the very next frame —
    // the "jump left" the user sees.
    //
    // Fix: project the node onto the camera's current forward ray. The pivot
    // moves to the node's depth along the view axis, so:
    //   (a) camera.lookAt(pivot) produces the same orientation as before
    //       → no view jump, node stays in the same screen position.
    //   (b) subsequent drag rotations orbit around that depth plane, which
    //       keeps the selected area roughly centered through the gesture.
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd); // unit vector in the current look direction

    const depth = nodePos.clone().sub(cam.position).dot(fwd);
    if (depth <= 0) return; // node is behind the camera — skip

    // Point on the view ray at the node's depth.
    ctrls.target.copy(cam.position).addScaledVector(fwd, depth);
    // No update() call — the library's own RAF loop picks up the new target
    // on the next tick. Since the pivot is on the current view ray,
    // camera.lookAt(target) leaves the orientation unchanged.
  }

  /**
   * Center the camera on a node AND emphasize its neighbors. Used when
   * the user explicitly asks to navigate (e.g., clicking a node from the
   * memory-trace sidebar or the Overview mini-atlas → jump to that node).
   * For sidebar-driven selection without camera movement use `select()`.
   *
   * Accounts for the atlas legend (200px wide, 12px left-inset) so the node
   * appears centered in the *visible* canvas area rather than the raw canvas
   * center. The camera is shifted left by half the legend's pixel footprint
   * (106 px) converted to world-space units at the target viewing distance.
   */
  focus(nodeId: string): void {
    const node = this.allNodes.find((n) => n.id === nodeId);
    if (!node) return;
    this.selectedId = nodeId;
    this.restylePredictedEdges();
    this.graph.linkOpacity(1.0);
    this.graph.nodeOpacity(1.0);

    const cam = this.graph.camera() as THREE.PerspectiveCamera;
    if (!cam) { this.graph.refresh(); return; }

    const nodePos = new THREE.Vector3(node.x ?? 0, node.y ?? 0, node.z ?? 0);

    // Direction from the current camera position toward the node.
    // Fall back to the camera's current look direction when the node
    // is coincident with the camera (edge-case: node at origin, cam at origin).
    let dir = nodePos.clone().sub(cam.position);
    const currentDist = dir.length();
    if (currentDist < 0.001) {
      cam.getWorldDirection(dir);
    } else {
      dir.divideScalar(currentDist);
    }

    // Step back from the node along the approach direction.
    // Clamp: close enough to see the node clearly, far enough to have context.
    const viewDist = Math.max(200, Math.min(currentDist * 0.9, 2000));
    const newCamPos = nodePos.clone().addScaledVector(dir, -viewDist);

    // ── Legend compensation ──────────────────────────────────────────
    // The atlas legend sits at [left:12px, width:200px] → occupies 212 px.
    // TC always renders the lookAt target at the image centre.  To make the
    // node appear at the centre of the VISIBLE area (right of the legend),
    // shift the lookAt target LEFT by 106 px of world units.  The node then
    // projects 106 px to the right of the image centre — at the visible centre.
    const LEGEND_OFFSET_PX = 106; // (200 + 12) / 2
    const rect = this.opts.container.getBoundingClientRect();
    let lookAt = nodePos.clone();
    if (rect.height > 0) {
      const fovRad = ((cam.fov ?? 75) * Math.PI) / 180;
      const unitsPerPx = (2 * Math.tan(fovRad / 2) * viewDist) / rect.height;
      const worldShift = LEGEND_OFFSET_PX * unitsPerPx;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      lookAt.addScaledVector(right, -worldShift); // lookAt moves left → node appears right
    }

    this.graph.cameraPosition(
      { x: newCamPos.x, y: newCamPos.y, z: newCamPos.z },
      { x: lookAt.x,    y: lookAt.y,    z: lookAt.z    },
      900,
    );
    // Re-render with neighbor emphasis applied via color callbacks.
    this.graph.refresh();
  }

  resetEmphasis(): void {
    this.selectedId = null;
    this.previewHighlightId = null;
    this.previewAnchorId = null;
    // Restore normal opacity multipliers now that there's no selection.
    // Do NOT touch ctrls.target — moving the orbit pivot without moving the
    // camera shifts the view direction and causes a visible jump.
    this.graph.linkOpacity(0.7);
    this.graph.nodeOpacity(0.92);
    this.restylePredictedEdges();
    this.graph.refresh();
  }

  /**
   * Transient hover highlight, called by the inspector when the user hovers
   * a connection row. Pass `null` to clear. Doesn't move the camera and
   * doesn't disturb the click-selection state — it's a pure visual preview
   * that ends as soon as the mouse leaves the row.
   */
  previewHighlight(nodeId: string | null, anchorId: string | null = null): void {
    // The anchor is only meaningful while a node is being previewed; clearing
    // the preview clears the anchor too.
    const nextAnchor = nodeId === null ? null : anchorId;
    if (this.previewHighlightId === nodeId && this.previewAnchorId === nextAnchor) return;
    this.previewHighlightId = nodeId;
    this.previewAnchorId = nextAnchor;
    // Predicted edges carry their color in their own material — restyle them
    // explicitly; the linkColor accessor only covers the real edges.
    this.restylePredictedEdges();
    // Force re-render so the accessors (nodeVal, nodeColor, linkColor) are
    // re-evaluated with the new highlight state.
    this.graph.refresh();
  }

  /**
   * Dim/brighten the dashed predicted-edge overlay to match the current
   * connection-row hover. A predicted edge's color is baked into its own
   * LineDashedMaterial, so it bypasses the linkColor accessor — this is the
   * only place its hover emphasis can be applied. No-op when no predictions
   * exist (the common, neural-network-disabled case).
   */
  private restylePredictedEdges(): void {
    if (this.predictedLineObjs.size === 0) return;
    const anchor = this.previewAnchorId ?? this.selectedId;
    const hovering = this.previewHighlightId !== null && anchor !== null;
    for (const l of this.predictedLinks) {
      const line = this.predictedLineObjs.get(l.id);
      if (line === undefined) continue;
      const mat = line.material as THREE.LineDashedMaterial;
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      if (hovering) {
        const isTheConnection =
          (sId === anchor && tId === this.previewHighlightId) ||
          (sId === this.previewHighlightId && tId === anchor);
        mat.opacity = isTheConnection ? 0.95 : 0.05;
      } else if (this.selectedId !== null) {
        // Selection mode — a predicted edge stays visible only if it touches
        // the selected node; non-incident ones dim hard, the same focus the
        // real edges get via computeColorForLink.
        const incident = sId === this.selectedId || tId === this.selectedId;
        mat.opacity = incident ? 0.7 : 0.05;
      } else {
        mat.opacity = 0.6; // neutral — default tentative-overlay opacity
      }
    }
  }

  /**
   * Toggle the constant gentle motion on or off. When OFF, the simulation
   * cools naturally and stops drifting — useful when the user wants the
   * graph stable so they can read content, screenshot, or carefully click
   * specific nodes. Returns the new state so the UI can update its label.
   */
  setAliveEnabled(enabled: boolean): boolean {
    this.aliveEnabled = enabled;
    if (!enabled) {
      // Let the current alpha decay to zero on its own — the user wanted
      // stillness, respect it. Existing reheat interval (if any) won't
      // fire because of the `aliveEnabled` short-circuit at the top of
      // the timer callback.
    } else {
      // Lazy-start the reheat loop if we're enabling motion mid-session
      // (default state is OFF post-init, so the loop hasn't been started
      // yet — calling setAliveEnabled(true) is how the user opts in).
      if (!this.opts.compact && this.reheatInterval === null) {
        this.startReheatLoop();
      }
      // Re-energize immediately so the user sees motion return.
      this.graph.d3ReheatSimulation();
    }
    return this.aliveEnabled;
  }
  isAliveEnabled(): boolean { return this.aliveEnabled; }

  /** Set the brain vitality (0-100). Scales pulsation amplitude, cluster breath, and reheat intensity. */
  setBrainVitality(vitality: number): void {
    this.brainVitality = Math.max(0, Math.min(100, vitality));
    // Restart reheat so the new intensity takes effect immediately.
    if (this.reheatInterval !== null) {
      clearInterval(this.reheatInterval);
      this.reheatInterval = null;
      this.startReheatLoop();
    }
  }

  /** Pause the Three.js render loop. Use when the App window is hidden
   *  or the user has navigated to a non-Atlas pane — Three.js doesn't
   *  pause itself, and a hot WebGL loop with active physics on a 2000+
   *  node graph is the single biggest source of background CPU drain. */
  pauseAnimation(): void { this.graph.pauseAnimation(); }

  /** Resume the render loop. Idempotent if not currently paused. */
  resumeAnimation(): void { this.graph.resumeAnimation(); }

  /** Re-apply current `globalThis.atlasPerf` flags to the live graph.
   *  Accessor-based flags (curves, arrows, particles, dim) take effect
   *  on the next render frame automatically. This forces an immediate
   *  refresh + nudges the collide radius which is locked at d3-force
   *  layer rather than read per-frame. */
  reapplyPerfFlags(): void {
    if (!this.opts.compact) {
      const collide = this.graph.d3Force('collide') as
        | undefined
        | { radius?: (fn: () => number) => unknown };
      collide?.radius?.(() => globalThis.atlasPerf.collide ? 14 * this.layoutScale : 0);
    }
    this.graph.refresh();
    this.graph.d3ReheatSimulation();
  }

  /** Release every pinned node so the simulation can re-flow. */
  unpinAll(): void {
    for (const n of this.allNodes) {
      delete n.fx; delete n.fy; delete n.fz;
    }
    this.graph.d3ReheatSimulation();
  }

  getNodes(): AtlasNode[] { return this.allNodes; }

  /** Connections (incoming/outgoing/mutual) for the inspector's neighbor list. */
  getConnections(nodeId: string): Array<{ neighborId: string; type: DirectedEdgeType | UndirectedEdgeType; category: EdgeCategory; direction: 'out' | 'in' | 'undirected'; weight: number }> {
    const out: Array<{ neighborId: string; type: DirectedEdgeType | UndirectedEdgeType; category: EdgeCategory; direction: 'out' | 'in' | 'undirected'; weight: number }> = [];
    for (const l of this.allLinks) {
      if (l.category === 'predicted') continue; // overlay layer — not a real connection
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      if (sId !== nodeId && tId !== nodeId) continue;
      const neighborId = sId === nodeId ? tId : sId;
      const direction: 'out' | 'in' | 'undirected' = !l.directed ? 'undirected' : sId === nodeId ? 'out' : 'in';
      out.push({ neighborId, type: l.type, category: l.category, direction, weight: l.weight });
    }
    return out.sort((a, b) => a.category.localeCompare(b.category) || b.weight - a.weight);
  }

  /**
   * Detect dense node agglomerations and animate them apart.
   *
   * Algorithm:
   *   1. Union-find over all nodes: any two nodes closer than
   *      `threshold` (in world units) are merged into the same cluster.
   *   2. Clusters with ≥ 4 nodes are "blobs."
   *   3. For each blob, compute the centroid and per-node target positions
   *      that push every node at least EXPAND × its current radius outward.
   *   4. Animate positions from start → target over ~1.8 s with an
   *      ease-out cubic so the expansion decelerates naturally.
   *   5. Nodes are pinned (fx/fy/fz) during animation so the d3-force
   *      simulation doesn't fight the outward movement.
   *   6. On completion: unpin everything, reheat physics so the graph
   *      settles organically from the new spread-out positions.
   *
   * Called automatically after initial layout converges. Also available
   * as a public method for external triggers (e.g. a toolbar button).
   */
  explodeClusters(): void {
    const nodes = this.allNodes.filter(n => n.x !== undefined && n.y !== undefined && n.z !== undefined);
    if (nodes.length < 4) return;

    // Proximity threshold: two nodes closer than this are considered part
    // of the same agglomeration. collide-force radius is 14 * scale;
    // blobs are nodes that are still overlapping or within each other's
    // personal bubble after the initial layout.
    const threshold  = 20 * this.layoutScale;
    const threshold2 = threshold * threshold;

    // ── Union-Find ─────────────────────────────────────────────────
    const parent = new Map<string, string>(nodes.map(n => [n.id, n.id] as [string, string]));
    const ufRank = new Map<string, number>(nodes.map(n => [n.id, 0] as [string, number]));

    const find = (id: string): string => {
      const p = parent.get(id) as string;
      if (p !== id) parent.set(id, find(p));
      return parent.get(id) as string;
    };
    const merge = (a: string, b: string): void => {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      const rankA = ufRank.get(ra) as number;
      const rankB = ufRank.get(rb) as number;
      if (rankA < rankB)      parent.set(ra, rb);
      else if (rankA > rankB) parent.set(rb, ra);
      else { parent.set(rb, ra); ufRank.set(ra, rankA + 1); }
    };

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i] as AtlasNode;
      const ax = a.x as number, ay = a.y as number, az = a.z as number;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j] as AtlasNode;
        const dx = ax - (b.x as number);
        const dy = ay - (b.y as number);
        const dz = az - (b.z as number);
        if (dx * dx + dy * dy + dz * dz < threshold2) merge(a.id, b.id);
      }
    }

    // ── Collect blobs ───────────────────────────────────────────────
    const clusterMap = new Map<string, AtlasNode[]>();
    for (const n of nodes) {
      const root = find(n.id);
      const arr = clusterMap.get(root) ?? [];
      arr.push(n);
      clusterMap.set(root, arr);
    }
    const blobs = [...clusterMap.values()].filter(c => c.length >= 4);
    if (blobs.length === 0) return;

    this.animateBlobExplosion(blobs);
  }

  private animateBlobExplosion(blobs: AtlasNode[][]): void {
    // Cancel any in-flight animation.
    if (this.blobAnimRAF !== null) {
      cancelAnimationFrame(this.blobAnimRAF);
      this.blobAnimRAF = null;
    }

    const DURATION_MS = 1800;
    // Push each node at least EXPAND × its current radius from the centroid.
    const EXPAND    = 3.2;
    // Minimum target distance from centroid regardless of current position.
    const MIN_DIST  = 28 * this.layoutScale;

    // ── Pre-compute start + target positions for every blob node ───
    const plans = blobs.map(cluster => {
      const cx = cluster.reduce((s, n) => s + (n.x as number), 0) / cluster.length;
      const cy = cluster.reduce((s, n) => s + (n.y as number), 0) / cluster.length;
      const cz = cluster.reduce((s, n) => s + (n.z as number), 0) / cluster.length;

      const nodeData = cluster.map(n => {
        const sx = n.x as number, sy = n.y as number, sz = n.z as number;
        const dx = sx - cx, dy = sy - cy, dz = sz - cz;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.5;
        const targetLen = Math.max(len * EXPAND, MIN_DIST);
        const s = targetLen / len;
        return {
          n,
          sx, sy, sz,
          tx: cx + dx * s,
          ty: cy + dy * s,
          tz: cz + dz * s,
        };
      });
      return nodeData;
    });

    // Pin nodes at their current positions — prevents d3-force from
    // overriding the animated positions each physics tick.
    for (const plan of plans) {
      for (const d of plan) {
        d.n.fx = d.n.x;
        d.n.fy = d.n.y;
        d.n.fz = d.n.z;
      }
    }

    // Keep unpinned nodes live (they can shift while blob nodes animate).
    this.graph.d3ReheatSimulation();

    const startTime = performance.now();

    const tick = (): void => {
      const raw = Math.min(1, (performance.now() - startTime) / DURATION_MS);
      // Ease-out cubic: fast start, decelerates into final position —
      // reads as organic "breathing open" rather than mechanical linear slide.
      const t = 1 - Math.pow(1 - raw, 3);

      for (const plan of plans) {
        for (const d of plan) {
          const x = d.sx + (d.tx - d.sx) * t;
          const y = d.sy + (d.ty - d.sy) * t;
          const z = d.sz + (d.tz - d.sz) * t;
          // Update both the position AND the pin so d3-force agrees.
          d.n.x = x;  d.n.fx = x;
          d.n.y = y;  d.n.fy = y;
          d.n.z = z;  d.n.fz = z;
        }
      }

      if (raw < 1) {
        this.blobAnimRAF = requestAnimationFrame(tick);
      } else {
        this.blobAnimRAF = null;
        // Unpin all blob nodes so physics can settle the new layout.
        for (const plan of plans) {
          for (const { n } of plan) {
            delete n.fx; delete n.fy; delete n.fz;
          }
        }
        // Warm physics back up so the graph finds its natural rest from
        // the newly spread-out positions.
        this.graph.d3ReheatSimulation();
      }
    };

    this.blobAnimRAF = requestAnimationFrame(tick);
  }

  // ── XYZ axes indicator ────────────────────────────────────────────────────
  //
  // A small SVG compass in the bottom-right of the graph container that shows
  // the orientation of the world X/Y/Z axes as the camera orbits. Rendered via
  // a requestAnimationFrame loop that reads cam.matrixWorldInverse each tick.
  // Each axis is drawn as a line from the indicator centre; axes pointing
  // toward the camera appear brighter, axes pointing away are dimmer.
  private setupAxesIndicator(): void {
    const SIZE = 72;
    const CX = SIZE / 2;
    const CY = SIZE / 2;
    const R  = SIZE * 0.36; // half-length of each axis arm

    const wrap = document.createElement('div');
    wrap.id = 'atlas-axes';
    Object.assign(wrap.style, {
      position: 'absolute', bottom: '14px', right: '14px',
      width:  `${SIZE}px`,
      height: `${SIZE}px`,
      pointerEvents: 'none',
      zIndex: '10',
      userSelect: 'none',
    });

    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width',   String(SIZE));
    svg.setAttribute('height',  String(SIZE));
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);

    // Frosted-glass background circle.
    const bg = document.createElementNS(NS, 'circle');
    bg.setAttribute('cx', String(CX));
    bg.setAttribute('cy', String(CY));
    bg.setAttribute('r',  String(CX - 1));
    bg.setAttribute('fill',   'rgba(10,12,18,0.55)');
    bg.setAttribute('stroke', 'rgba(255,255,255,0.07)');
    bg.setAttribute('stroke-width', '1');
    svg.appendChild(bg);

    const AXES = [
      { label: 'X', color: '#e05555', vec: new THREE.Vector3(1, 0, 0) },
      { label: 'Y', color: '#55c055', vec: new THREE.Vector3(0, 1, 0) },
      { label: 'Z', color: '#5588e0', vec: new THREE.Vector3(0, 0, 1) },
    ] as const;

    // Each axis: negative arm (dim), positive arm (bright), label.
    // We create them all upfront and update attributes each frame.
    type AxisEls = { neg: SVGLineElement; pos: SVGLineElement; txt: SVGTextElement };
    const elsByAxis: AxisEls[] = [];

    for (const ax of AXES) {
      const neg = document.createElementNS(NS, 'line');
      neg.setAttribute('stroke-width',  '1.5');
      neg.setAttribute('stroke-linecap', 'round');
      svg.appendChild(neg);

      const pos = document.createElementNS(NS, 'line');
      pos.setAttribute('stroke-width',  '2');
      pos.setAttribute('stroke-linecap', 'round');
      svg.appendChild(pos);

      const txt = document.createElementNS(NS, 'text');
      txt.setAttribute('font-size',         '8');
      txt.setAttribute('font-family',       'system-ui,sans-serif');
      txt.setAttribute('font-weight',       '700');
      txt.setAttribute('text-anchor',       'middle');
      txt.setAttribute('dominant-baseline', 'central');
      txt.textContent = ax.label;
      svg.appendChild(txt);

      elsByAxis.push({ neg, pos, txt });
    }

    wrap.appendChild(svg);
    this.opts.container.appendChild(wrap);
    this.axesEl = wrap;

    const invQuat = new THREE.Quaternion();
    const tmp     = new THREE.Vector3();

    const tick = () => {
      this.axesRAF = requestAnimationFrame(tick);
      const cam = this.graph.camera() as THREE.PerspectiveCamera | null;
      if (!cam) return;

      // Transform each world axis into camera space to get its 2D projection.
      invQuat.copy(cam.quaternion).invert();

      // Build projected [sx, sy, z] for each axis, then sort back-to-front
      // so closer axes are drawn on top.
      const projected = AXES.map((ax, i) => {
        tmp.copy(ax.vec).applyQuaternion(invQuat);
        // Camera space: x=right, y=up, z=toward camera (+z faces us).
        const sx = CX + tmp.x * R;
        const sy = CY - tmp.y * R; // flip Y for screen coords
        return { i, color: ax.color, sx, sy, z: tmp.z };
      });

      // Render back-to-front (lowest z first) so nearer axes overdraw far ones.
      projected.sort((a, b) => a.z - b.z);

      // Remove existing SVG children except background, then re-append in order.
      // Cheaper: just update attributes; depth-order is handled via opacity.
      for (const { i, color, sx, sy, z } of projected) {
        // alpha: 1.0 when pointing straight at camera (z=1), 0.25 when away (z=-1).
        const alpha = 0.25 + 0.75 * Math.max(0, (z + 1) / 2);
        const els = elsByAxis[i];
        if (!els) continue;
        const { neg, pos, txt } = els;

        // Positive arm: center → tip.
        pos.setAttribute('x1', String(CX)); pos.setAttribute('y1', String(CY));
        pos.setAttribute('x2', String(sx)); pos.setAttribute('y2', String(sy));
        pos.setAttribute('stroke',  color);
        pos.setAttribute('opacity', String(alpha.toFixed(2)));

        // Negative arm: center → opposite tip (half length, much dimmer).
        const nx = CX - (sx - CX) * 0.45;
        const ny = CY - (sy - CY) * 0.45;
        neg.setAttribute('x1', String(CX)); neg.setAttribute('y1', String(CY));
        neg.setAttribute('x2', String(nx)); neg.setAttribute('y2', String(ny));
        neg.setAttribute('stroke',  color);
        neg.setAttribute('opacity', String((alpha * 0.35).toFixed(2)));

        // Label just beyond the positive tip.
        const lx = sx + (sx - CX) * 0.28;
        const ly = sy + (sy - CY) * 0.28;
        txt.setAttribute('x', String(lx.toFixed(1)));
        txt.setAttribute('y', String(ly.toFixed(1)));
        txt.setAttribute('fill',    color);
        txt.setAttribute('opacity', String(Math.max(0.45, alpha).toFixed(2)));

        // Re-insert in sorted order so SVG paint order = back→front.
        svg.appendChild(neg);
        svg.appendChild(pos);
        svg.appendChild(txt);
      }
    };
    this.axesRAF = requestAnimationFrame(tick);
  }

  /** True when the orbit debug HUD is currently shown. */
  isOrbitDebugHUDVisible(): boolean { return this.dbgEl !== null; }

  /** Stop and remove the debug HUD overlay. Safe to call if not shown. */
  stopOrbitDebugHUD(): void {
    if (this.dbgRAF !== null) { cancelAnimationFrame(this.dbgRAF); this.dbgRAF = null; }
    this.dbgEl?.remove();
    this.dbgEl = null;
    this.dbgPrevCamPos = null;
    this.dbgLastJump   = null;
    this.dbgLastPole   = null;
  }

  /** Orbit debug HUD — shows live camera/pivot/clamp values during rotation.
   *  Logs a ⚠ warning to the console whenever it detects a glitch condition.
   *  Hidden by default; enable via Settings → Support (session-only). */
  startOrbitDebugHUD(): void {
    if (this.dbgEl) return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute', 'top:10px', 'right:10px',
      'background:rgba(0,0,0,0.82)', 'color:#0f0', 'font:11px/1.5 monospace',
      'padding:8px 10px', 'border-radius:6px', 'pointer-events:auto',
      'z-index:9999', 'min-width:280px', 'white-space:pre', 'cursor:pointer',
    ].join(';');
    el.title = 'Click to clear sticky warnings';
    this.opts.container.style.position ||= 'relative';
    this.opts.container.appendChild(el);
    this.dbgEl = el;

    // Click to reset sticky JUMP / NEAR POLE records.
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.dbgLastJump = null;
      this.dbgLastPole = null;
    });

    const r3 = (v: number) => v.toFixed(3);
    const r1 = (v: number) => v.toFixed(1);
    const toDeg = (r: number) => ((r * 180) / Math.PI).toFixed(1) + '°';
    const ago   = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s ago`;

    const dbgTick = () => {
      this.dbgRAF = requestAnimationFrame(dbgTick);
      const cam    = this.graph?.camera() as THREE.PerspectiveCamera | null;
      const ctrlsT = this.graph?.controls() as { target?: THREE.Vector3 } | null;
      if (!cam || !el.isConnected) return;

      const pos    = cam.position;
      const fwd    = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      const fwdPhi = Math.acos(Math.max(-1, Math.min(1, fwd.y)));
      const active = this.isOrbiting;

      // ── JUMP detection ───────────────────────────────────────────────────
      const JUMP_THRESHOLD = 50;
      if (this.dbgPrevCamPos) {
        const delta = pos.distanceTo(this.dbgPrevCamPos);
        if (delta > JUMP_THRESHOLD) {
          const snap = [
            `  cam.pos  ${r1(pos.x)} ${r1(pos.y)} ${r1(pos.z)}`,
            `  cam.fwd  ${r3(fwd.x)} ${r3(fwd.y)} ${r3(fwd.z)}`,
            `  fwdPhi   ${toDeg(fwdPhi)}`,
            `  orbit:   ${active ? 'ACTIVE' : 'idle'}`,
            `  target   ${ctrlsT?.target ? `${r1(ctrlsT.target.x)} ${r1(ctrlsT.target.y)} ${r1(ctrlsT.target.z)}` : 'null'}`,
          ].join('\n');
          // Keep the largest jump seen.
          if (!this.dbgLastJump || delta > this.dbgLastJump.delta) {
            this.dbgLastJump = { delta, snapshot: snap, at: Date.now() };
          }
          console.warn(`[orbit-dbg] Camera jumped ${delta.toFixed(1)} units\n${snap}`);
        }
      }
      this.dbgPrevCamPos = pos.clone();

      // ── NEAR POLE detection ──────────────────────────────────────────────
      const POLE_WARN_RAD = 25 * Math.PI / 180;
      const nearPole = fwdPhi < POLE_WARN_RAD || fwdPhi > Math.PI - POLE_WARN_RAD;
      if (nearPole) {
        const snap = [
          `  fwdPhi   ${toDeg(fwdPhi)}`,
          `  cam.fwd  ${r3(fwd.x)} ${r3(fwd.y)} ${r3(fwd.z)}`,
          `  orbit:   ${active ? 'ACTIVE' : 'idle'}`,
        ].join('\n');
        // Keep the most-extreme fwdPhi seen (closest to 0° or 180°).
        const severity = Math.min(fwdPhi, Math.PI - fwdPhi);
        const prevSev  = this.dbgLastPole ? Math.min(this.dbgLastPole.phi, Math.PI - this.dbgLastPole.phi) : Infinity;
        if (!this.dbgLastPole || severity < prevSev) {
          this.dbgLastPole = { phi: fwdPhi, snapshot: snap, at: Date.now() };
        }
      }

      // ── Build HUD text ───────────────────────────────────────────────────
      const lines: string[] = [
        `orbit: ${active ? '🟢 ACTIVE (TC)' : '⚫ idle/cosmos'}`,
        `cam.pos  ${r1(pos.x)} ${r1(pos.y)} ${r1(pos.z)}`,
        `cam.fwd  ${r3(fwd.x)} ${r3(fwd.y)} ${r3(fwd.z)}`,
        `fwdPhi   ${toDeg(fwdPhi)}  (${r3(fwdPhi)} rad)`,
        `TC.target ${ctrlsT?.target ? `${r1(ctrlsT.target.x)} ${r1(ctrlsT.target.y)} ${r1(ctrlsT.target.z)}` : 'null'}`,
        '',
        // Sticky JUMP — always shown, holds worst value until click-to-clear.
        this.dbgLastJump
          ? `⚠ JUMP  Δpos=${r1(this.dbgLastJump.delta)}  (${ago(this.dbgLastJump.at)})\n${this.dbgLastJump.snapshot}`
          : '✓ no jump',
        '',
        // Sticky NEAR POLE — always shown, holds worst fwdPhi until click-to-clear.
        this.dbgLastPole
          ? `⚠ NEAR POLE  fwdPhi=${toDeg(this.dbgLastPole.phi)}  (${ago(this.dbgLastPole.at)})\n${this.dbgLastPole.snapshot}`
          : '✓ no pole',
        '',
        '[click to clear sticky warnings]',
      ];
      el.textContent = lines.join('\n');
    };
    this.dbgRAF = requestAnimationFrame(dbgTick);
  }

  // (stopOrbitDebugHUD is now the public method above)

  dispose(): void {
    this.resizeObs?.disconnect();
    if (this.elasticTimer !== null) {
      clearTimeout(this.elasticTimer);
      this.elasticTimer = null;
    }
    if (this.axesRAF !== null) {
      cancelAnimationFrame(this.axesRAF);
      this.axesRAF = null;
    }
    this.axesEl?.remove();
    this.axesEl = null;
    this.stopOrbitDebugHUD();
    if (this.blobAnimRAF !== null) {
      cancelAnimationFrame(this.blobAnimRAF);
      this.blobAnimRAF = null;
    }
    if (this.cosmosLoopId !== null) {
      cancelAnimationFrame(this.cosmosLoopId);
      this.cosmosLoopId = null;
    }
    this.jellyVelocities.clear();
    if (this.reheatInterval !== null) {
      clearInterval(this.reheatInterval);
      this.reheatInterval = null;
    }
    if (this.lodRefreshTimer !== null) {
      clearTimeout(this.lodRefreshTimer);
      this.lodRefreshTimer = null;
    }
    if (!this.opts.compact) {
      this.opts.container.removeEventListener('wheel', this.onWheel);
      // ── grab-to-rotate-pivot dispose (DISABLED — see matching wiring comment
      //    above in the controls-init block. If re-enabling the pointerdown
      //    listener, also uncomment the four removeEventListener lines below).
      // this.opts.container.removeEventListener('pointerdown', this.onGrabPointerDown, true);
      // this.opts.container.removeEventListener('pointermove', this.onGrabPointerMove);
      // this.opts.container.removeEventListener('pointerup', this.onGrabPointerUp);
      // this.opts.container.removeEventListener('pointercancel', this.onGrabPointerUp);
      if (this.onModKeyDown) window.removeEventListener('keydown', this.onModKeyDown);
      if (this.onModKeyUp) window.removeEventListener('keyup', this.onModKeyUp);
    }
    // 3d-force-graph exposes _destructor on the instance.
    const inst = this.graph as unknown as { _destructor?: () => void };
    inst._destructor?.();
  }

  // ── Color helpers (with neighbor-dimming when a node is selected) ────
  //
  // Critical perf path: 3d-force-graph invokes these accessors on EVERY
  // visible node + link, EVERY frame. For a 364-node / 1184-link graph at
  // 60fps that's ~93K calls/sec. Each call to applyAlpha() previously
  // allocated a new THREE.Color, did 3 Math.round + a toFixed, and
  // concatenated strings — collectively many MB/sec of allocation
  // pressure and several ms of CPU per frame.
  //
  // The fix: cache the final RGBA string per node/link, keyed implicitly
  // on the rendering state (selectedId + previewHighlightId + draggingId
  // + allLinks reference). Selection state changes are rare (user
  // gestures); the cache survives every frame in between until one of
  // those state fields shifts. Cache rebuild on state change is O(N) once.

  private nodeColorCache = new Map<string, string>();
  private linkColorCache = new Map<string, string>();
  private particleColorCache = new Map<string, string>();
  private particleCountCache = new Map<string, number>();
  private colorCacheState: {
    selectedId: string | null;
    previewHighlightId: string | null;
    previewAnchorId: string | null;
    draggingId: string | null;
    previewLegendCategory: EdgeCategory | null;
    previewLegendSource: string | null;
    linksRef: AtlasLink[];
  } | null = null;

  /** Drops the color caches when any input has changed since the last
   *  cache build. Cheap to call — six reference equality checks. */
  private ensureColorCachesFresh(): void {
    const s = this.colorCacheState;
    if (
      s !== null &&
      s.selectedId === this.selectedId &&
      s.previewHighlightId === this.previewHighlightId &&
      s.previewAnchorId === this.previewAnchorId &&
      s.draggingId === this.draggingId &&
      s.previewLegendCategory === this.previewLegendCategory &&
      s.previewLegendSource === this.previewLegendSource &&
      s.linksRef === this.allLinks
    ) return;
    this.nodeColorCache.clear();
    this.linkColorCache.clear();
    this.particleColorCache.clear();
    this.particleCountCache.clear();
    this.colorCacheState = {
      selectedId: this.selectedId,
      previewHighlightId: this.previewHighlightId,
      previewAnchorId: this.previewAnchorId,
      draggingId: this.draggingId,
      previewLegendCategory: this.previewLegendCategory,
      previewLegendSource: this.previewLegendSource,
      linksRef: this.allLinks,
    };
  }

  private colorForNode(n: AtlasNode): string {
    this.ensureColorCachesFresh();
    const cached = this.nodeColorCache.get(n.id);
    if (cached !== undefined) return cached;
    const computed = this.computeColorForNode(n);
    this.nodeColorCache.set(n.id, computed);
    return computed;
  }

  private computeColorForNode(n: AtlasNode): string {
    const base = colorForSource(n.sourceFile);

    // LEGEND CATEGORY HOVER — dim all nodes except those touched by the
    // previewed category's edges, which glow at full brightness.
    if (this.previewLegendCategory !== null) {
      return this.previewCatNodeIds.has(n.id)
        ? this.applyAlpha(this.brighten(base, 0.2), 1.0)
        : this.applyAlpha(base, 0.06);
    }

    // LEGEND SOURCE HOVER — dim all nodes except those belonging to the
    // hovered source, which glow at full brightness.
    if (this.previewLegendSource !== null) {
      return (n.sourceFile ?? '') === this.previewLegendSource
        ? this.applyAlpha(this.brighten(base, 0.2), 1.0)
        : this.applyAlpha(base, 0.06);
    }

    if (!globalThis.atlasPerf.dim) {
      // Selected node → spotlight white so it's a clear focal point even
      // without the rest of the graph dimming around it.
      if (n.id === this.selectedId) return this.applyAlpha(0xffffff, 1.0);
      // Hover mode: only the anchor (the inspector's node) + the hovered
      // neighbour are at full brightness. The anchor falls back to selectedId,
      // so the hover works even with no prior click-selection in the 3D view.
      const hoverAnchor = this.previewAnchorId ?? this.selectedId;
      if (this.previewHighlightId !== null && hoverAnchor !== null) {
        if (n.id === hoverAnchor) return this.applyAlpha(0xffffff, 1.0);
        if (n.id === this.previewHighlightId) return this.applyAlpha(this.brighten(base, 0.25), 1.0);
        return this.applyAlpha(base, 0.15);
      }
      return this.applyAlpha(base, 1.0);
    }
    return this.computeColorForNodeDim(n);
  }

  private computeColorForNodeDim(n: AtlasNode): string {
    const base = colorForSource(n.sourceFile);

    // DRAG MODE — the dragged node always reads as a glowing "anchor" in
    // whatever the current emphasis state happens to be. Brightens toward
    // white so the user's eye stays on it no matter how fast they fling it.
    if (this.draggingId === n.id) {
      return this.applyAlpha(this.brighten(base, 0.4), 1.0);
    }

    // HOVER MODE — sidebar connection row is being hovered. Show ONLY the
    // selected node + the hovered neighbor at full brightness; dim every
    // other node hard. This isolates the single relationship being inspected
    // and makes "which two memories are linked here" unambiguous.
    const hoverAnchor = this.previewAnchorId ?? this.selectedId;
    if (this.previewHighlightId !== null && hoverAnchor !== null) {
      if (n.id === hoverAnchor) return this.applyAlpha(0xffffff, 1.0); // spotlight white
      if (n.id === this.previewHighlightId) return this.applyAlpha(this.brighten(base, 0.25), 1.0);
      return this.applyAlpha(base, 0.18);
    }

    // NEUTRAL — nothing selected. Every node at full opacity, no confidence
    // dimming. The graph reads as "all here, no focus yet."
    if (this.selectedId === null) {
      return this.applyAlpha(base, 1.0);
    }

    // SELECTION — selected node goes spotlight-white so it reads as a
    // clear focal point against the dimmed graph. Neighbors stay at their
    // source color (full brightness) to show the connected neighborhood.
    // Non-neighbors dim but stay legible (0.22 instead of 0.08 — enough
    // contrast to read the selection without losing the galaxy context).
    if (n.id === this.selectedId) return this.applyAlpha(0xffffff, 1.0); // spotlight white
    if (this.isNeighborOf(n.id, this.selectedId)) return this.applyAlpha(this.brighten(base, 0.15), 1.0);
    return this.applyAlpha(base, 0.22);
  }

  private colorForLink(l: AtlasLink): string {
    this.ensureColorCachesFresh();
    const cached = this.linkColorCache.get(l.id);
    if (cached !== undefined) return cached;
    const computed = this.computeColorForLink(l);
    this.linkColorCache.set(l.id, computed);
    return computed;
  }

  private isCrossFileEdge(l: AtlasLink): boolean {
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
    return this.nodeSourceFileMap.get(sId) !== this.nodeSourceFileMap.get(tId);
  }

  /** Resolve the base color for a link, applying per-evidence overrides first.
   *  See EVIDENCE_COLOR_OVERRIDE for the active override map. */
  private baseColorForLink(l: AtlasLink): number {
    if (l.evidence) {
      // Structured evidences (e.g. `skill:calls;capture=foo`) — match the base tag.
      const baseTag = l.evidence.split(';')[0]!;
      const override = EVIDENCE_COLOR_OVERRIDE[baseTag];
      if (override !== undefined) return override;
    }
    return CATEGORY_COLOR[l.category];
  }

  private computeColorForLink(l: AtlasLink): string {
    const crossFile = this.isCrossFileEdge(l);
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
    const base = this.baseColorForLink(l);

    // LEGEND CATEGORY HOVER — the hovered category's edges glow; all others
    // fade to near-invisible so the pattern for that category pops clearly.
    if (this.previewLegendCategory !== null) {
      return l.category === this.previewLegendCategory
        ? this.applyAlpha(base, 1.0)
        : this.applyAlpha(base, 0.04);
    }

    // LEGEND SOURCE HOVER — edges where BOTH endpoints are in the hovered
    // source glow; cross-source edges touching the source ghost softly;
    // fully-external edges fade to near-invisible.
    if (this.previewLegendSource !== null) {
      const sFile = this.nodeSourceFileMap.get(sId) ?? '';
      const tFile = this.nodeSourceFileMap.get(tId) ?? '';
      const srcMatch = this.previewLegendSource;
      if (sFile === srcMatch && tFile === srcMatch) return this.applyAlpha(base, 1.0);
      if (sFile === srcMatch || tFile === srcMatch) return this.applyAlpha(base, 0.22);
      return this.applyAlpha(base, 0.04);
    }

    if (!globalThis.atlasPerf.dim) {
      // HOVER — only the specific edge between selected + hovered pair is
      // bright; everything else dims to near-invisible. Cross-file / LOD
      // rules don't apply here — the user is explicitly looking at this edge.
      const hoverAnchor = this.previewAnchorId ?? this.selectedId;
      if (this.previewHighlightId !== null && hoverAnchor !== null) {
        const isTheConnection =
          (sId === hoverAnchor && tId === this.previewHighlightId) ||
          (sId === this.previewHighlightId && tId === hoverAnchor);
        return this.applyAlpha(base, isTheConnection ? 1.0 : 0.04);
      }

      // SELECTION — directed incident edges: dim the line so the bright
      // flowing particles are clearly visible against the dark tube.
      // Undirected incident edges: full color (no particles to contrast with).
      if (this.selectedId !== null) {
        if (sId === this.selectedId || tId === this.selectedId) {
          return l.directed
            ? this.applyAlpha(base, 0.20)
            : this.applyAlpha(base, 1.0);
        }
      }

      // NEUTRAL — directed edges keep a moderately strong tube (raised from
      // the old near-invisible 0.20): they must stay legible, and stay
      // distinguishable from the undirected edges, even on a large graph
      // zoomed out. Still kept a touch below the undirected 1.0 so the bright
      // flowing particles pop against the tube. Cross-file semantic/identity
      // edges get LOD suppression; other cross-file edges are ghosted;
      // same-file undirected edges are full.
      if (l.directed) return this.applyAlpha(base, 0.65);
      if (crossFile && (l.category === 'semantic' || l.category === 'identity')) {
        return this.applyAlpha(base, this.lodSemanticAlpha());
      }
      return this.applyAlpha(base, crossFile ? 0.22 : 1.0);
    }
    return this.computeColorForLinkDim(l, crossFile);
  }

  /**
   * LOD alpha for cross-cluster semantic / identity edges.
   * At overview zoom (lodBucket 2) these are very faint so the dense
   * teal web doesn't dominate. As the user flies into a cluster the
   * opacity rises so the semantic connections become readable up close.
   *
   *   bucket 0 (close,  dist < 250): 0.22 — same as other cross-file edges
   *   bucket 1 (mid,    250–550):    0.10 — partially suppressed
   *   bucket 2 (far,    > 550):      0.05 — near-invisible web
   */
  private lodSemanticAlpha(): number {
    switch (this.lodBucket(this.lodCamDist)) {
      case 0:  return 0.22;
      case 1:  return 0.10;
      default: return 0.05;
    }
  }

  private computeColorForLinkDim(l: AtlasLink, crossFile = this.isCrossFileEdge(l)): string {
    const base = this.baseColorForLink(l);
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;

    // Legend preview states are handled before entering this function
    // (computeColorForLink returns early). But as belt-and-suspenders, guard
    // here too so dim-mode callers don't see stale non-preview colors.
    if (this.previewLegendCategory !== null) {
      return l.category === this.previewLegendCategory
        ? this.applyAlpha(base, 1.0)
        : this.applyAlpha(base, 0.04);
    }
    if (this.previewLegendSource !== null) {
      const sFile = this.nodeSourceFileMap.get(sId) ?? '';
      const tFile = this.nodeSourceFileMap.get(tId) ?? '';
      const srcMatch = this.previewLegendSource;
      if (sFile === srcMatch && tFile === srcMatch) return this.applyAlpha(base, 1.0);
      if (sFile === srcMatch || tFile === srcMatch) return this.applyAlpha(base, 0.22);
      return this.applyAlpha(base, 0.04);
    }

    // HOVER MODE — only the edge(s) connecting the selected node to the
    // hovered neighbor are bright. Multiple edges between the same pair
    // (directed + undirected) all qualify. Everything else dims hard.
    const hoverAnchor = this.previewAnchorId ?? this.selectedId;
    if (this.previewHighlightId !== null && hoverAnchor !== null) {
      const isTheConnection =
        (sId === hoverAnchor && tId === this.previewHighlightId) ||
        (sId === this.previewHighlightId && tId === hoverAnchor);
      if (isTheConnection) return this.applyAlpha(this.brighten(base, 0.25), 1.0);
      return this.applyAlpha(base, 0.04);
    }

    // NEUTRAL — directed edges dimmed so particles stay visible inside the tube.
    // Undirected: within-file full, cross-file ghosted.
    if (this.selectedId === null) {
      if (l.directed) return this.applyAlpha(base, 0.20);
      return this.applyAlpha(base, crossFile ? 0.22 : 1.0);
    }

    // SELECTION — directed incident: dim line so flowing particles pop visually.
    // Undirected incident: bright. Non-incident: legible ghost.
    const connected = sId === this.selectedId || tId === this.selectedId;
    if (connected) {
      return l.directed
        ? this.applyAlpha(base, 0.20)
        : this.applyAlpha(base, 1.0);
    }
    return this.applyAlpha(base, 0.18);
  }

  /**
   * Particle count per directed edge. Mirrors the same emphasis rules as
   * the rest of the rendering:
   *   - Hover mode: only the single hovered connection keeps its pulses.
   *   - Selection mode: only edges incident to the selected node pulse.
   *   - Neutral: every directed edge pulses with 2 particles.
   * Undirected edges never pulse.
   */
  private particleCountFor(l: AtlasLink): number {
    this.ensureColorCachesFresh();
    const cached = this.particleCountCache.get(l.id);
    if (cached !== undefined) return cached;
    const computed = this.computeParticleCountFor(l);
    this.particleCountCache.set(l.id, computed);
    return computed;
  }

  private computeParticleCountFor(l: AtlasLink): number {
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;

    // HOVER — single connection lit up, everything else dead.
    const hoverAnchor = this.previewAnchorId ?? this.selectedId;
    if (this.previewHighlightId !== null && hoverAnchor !== null) {
      const isTheConnection =
        (sId === hoverAnchor && tId === this.previewHighlightId) ||
        (sId === this.previewHighlightId && tId === hoverAnchor);
      return isTheConnection ? 6 : 0;
    }

    // SELECTION — only directed edges incident to the selected node carry
    // particles.  Non-incident directed edges go dark (count=0) so the eye
    // is drawn to the connections that matter.  Undirected edges never carry
    // particles regardless (they have no inherent flow direction).
    if (this.selectedId !== null) {
      if (!l.directed) return 0;
      const isIncident = sId === this.selectedId || tId === this.selectedId;
      return isIncident ? 14 : 0; // 14 particles = dense, clearly-directional burst
    }

    // NEUTRAL — directed edges always carry 8 particles at high intensity
    // so the flow of knowledge through the graph is permanently visible.
    // Undirected (semantic) edges have no intrinsic direction — no particles.
    return l.directed ? 8 : 0;
  }

  /**
   * Particle color follows the same emphasis rules as the edge itself.
   * When a node is selected, only particles on incident edges glow; the
   * rest dim hard. Without this, "ghost pulses" would still flow along
   * dimmed edges and pull the eye away from the selected neighborhood.
   *
   * Neutral / non-emphasis state still uses a white-shifted boost so the
   * pulses pop visibly against their host edge.
   */
  private brightParticleColor(l: AtlasLink): string {
    this.ensureColorCachesFresh();
    const cached = this.particleColorCache.get(l.id);
    if (cached !== undefined) return cached;
    const computed = this.computeBrightParticleColor(l);
    this.particleColorCache.set(l.id, computed);
    return computed;
  }

  private computeBrightParticleColor(l: AtlasLink): string {
    const base = this.baseColorForLink(l);
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;

    // HOVER MODE — only the one hovered connection's particles glow.
    const hoverAnchor = this.previewAnchorId ?? this.selectedId;
    if (this.previewHighlightId !== null && hoverAnchor !== null) {
      const isTheConnection =
        (sId === hoverAnchor && tId === this.previewHighlightId) ||
        (sId === this.previewHighlightId && tId === hoverAnchor);
      return isTheConnection
        ? this.applyAlpha(this.brighten(base, 0.45), 1.0)
        : this.applyAlpha(base, 0.04);
    }

    // SELECTION MODE — particles only on edges touching the selected node.
    if (this.selectedId !== null) {
      const connected = sId === this.selectedId || tId === this.selectedId;
      return connected
        ? this.applyAlpha(this.brighten(base, 0.45), 1.0)
        : this.applyAlpha(base, 0.06);
    }

    // NEUTRAL — full white-shifted glow on every directed edge.
    return this.applyAlpha(this.brighten(base, 0.45), 1.0);
  }

  /**
   * Blend a color toward white by `amt` (0..1). Cheap "highlight" effect
   * that keeps the source-color identity while making the previewed node
   * read as "this one, right now."
   */
  private brighten(hexInt: number, amt: number): number {
    const c = new THREE.Color(hexInt);
    c.r = Math.min(1, c.r + (1 - c.r) * amt);
    c.g = Math.min(1, c.g + (1 - c.g) * amt);
    c.b = Math.min(1, c.b + (1 - c.b) * amt);
    return c.getHex();
  }

  /**
   * O(1) neighbor lookup, with a tiny memoization cache keyed on
   * (selectedId, allLinks-reference). Critical perf path: 3d-force-graph
   * calls our `colorForNode` accessor on every visible node every frame,
   * which used to call this method O(E) per call → O(N × E) per frame.
   *
   * For typical cortexes (hundreds of nodes, ~1000 edges) the naive loop
   * pushed total work past 25M ops/sec just for the dim color decision
   * — visible as severe lag the moment a node got selected.
   *
   * Cache invalidates automatically on:
   *   - new selection (selectedId changes)
   *   - graph data reload (allLinks gets a new array reference,
   *     happens in pushDataIntoAtlas after every mutation reload)
   */
  private cachedNeighbors: { selectedId: string; linksRef: AtlasLink[]; set: Set<string> } | null = null;

  private isNeighborOf(candidateId: string, selectedId: string): boolean {
    if (
      this.cachedNeighbors === null ||
      this.cachedNeighbors.selectedId !== selectedId ||
      this.cachedNeighbors.linksRef !== this.allLinks
    ) {
      const set = new Set<string>();
      for (const l of this.allLinks) {
        const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
        const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
        if (sId === selectedId) set.add(tId);
        else if (tId === selectedId) set.add(sId);
      }
      this.cachedNeighbors = { selectedId, linksRef: this.allLinks, set };
    }
    return this.cachedNeighbors.set.has(candidateId);
  }

  private applyAlpha(hexInt: number, alpha: number): string {
    // 3d-force-graph accepts CSS rgba strings for node/link color.
    const c = new THREE.Color(hexInt);
    return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${alpha.toFixed(2)})`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
  }
}
