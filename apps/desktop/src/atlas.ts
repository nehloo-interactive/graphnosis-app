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

export type EdgeCategory = 'reasoning' | 'structure' | 'social' | 'temporal' | 'semantic' | 'identity';

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
  social:    0xc084fc,
  temporal:  0xfbbf24,
  semantic:  0x6ab3c8,
  identity:  0x9a9a9c,
};
export const CATEGORY_LABEL: Record<EdgeCategory, string> = {
  reasoning: 'Reasoning',
  structure: 'Structure',
  social:    'Social',
  temporal:  'Temporal',
  semantic:  'Semantic',
  identity:  'Identity',
};
export function categoryFor(directed: boolean, type: DirectedEdgeType | UndirectedEdgeType): EdgeCategory {
  if (directed) return DIRECTED_CATEGORY[type as DirectedEdgeType];
  return UNDIRECTED_CATEGORY[type as UndirectedEdgeType];
}

// How long after a mousemove on the canvas we suppress the periodic
// reheat. Long enough to read as "user is targeting"; short enough to
// resume drifting once they've truly stopped.
const SUPPRESS_AFTER_MOVE_MS = 6_000;
// How long after an empty-canvas click. Much longer — clicking empty
// space is a deliberate "stop" gesture, the user wants stillness.
const SUPPRESS_AFTER_CLICK_MS = 30_000;

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

/** Internal link shape — 3d-force-graph wants a flat {source, target} list. */
interface AtlasLink {
  id: string;
  source: string; // node id (becomes node ref after simulation init)
  target: string;
  directed: boolean;
  type: DirectedEdgeType | UndirectedEdgeType;
  category: EdgeCategory;
  weight: number;
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
  private allLinks: AtlasLink[] = [];
  private categoryVisible: Record<EdgeCategory, boolean> = {
    reasoning: true, structure: true, social: true, temporal: true, semantic: true, identity: true,
  };
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
   * Node currently being dragged. Used to:
   *   - Boost its size + brightness for visual feedback ("you're holding this one").
   *   - Amplify incident edge forces so the graph elastically follows.
   *   - Pin the node where the user drops it (set in onNodeDragEnd).
   */
  private draggingId: string | null = null;
  /**
   * Multiplier that scales link distances and charge strength based on
   * how many nodes the graph holds. Recomputed in setNodes. Default 1 for
   * tiny graphs; grows with sqrt(N) so the layout breathes proportionally
   * as the engram fills up — dense clusters don't end up jammed into a
   * pixel-thick mass.
   */
  private layoutScale = 1;
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
  private aliveEnabled = true;
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
    g.nodeRelSize(3.2);
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
      // Visual feedback boost: previewed = +70%, dragged = +50% (lasts the
      // whole hold). Both can stack in edge cases — clamp keeps it sane.
      if (this.previewHighlightId === n.id) base *= 1.7;
      if (this.draggingId === n.id) base *= 1.5;
      return base;
    });
    g.nodeColor((n: AtlasNode) => this.colorForNode(n));
    g.nodeOpacity(0.92);
    // 3d-force-graph supports a `nodeLabel` callback that renders a tooltip
    // on hover. Keep it compact — first 120 chars of the memory content.
    g.nodeLabel((n: AtlasNode) => this.escapeHtml(n.text.slice(0, 160)) + (n.text.length > 160 ? '…' : ''));

    // Links: colored by category, width by weight, with arrowheads on
    // directional links sized proportional to weight.
    g.linkColor((l: AtlasLink) => this.colorForLink(l));
    g.linkOpacity(0.7);
    // Edge thickness reflects weight on a wider range than before (was
    // 0.4..3, now 0.4..5) so high-confidence relationships read as clearly
    // thicker than weak ones. Quadratic ramp makes the high end dramatic.
    g.linkWidth((l: AtlasLink) => Math.max(0.4, Math.min(5, 0.4 + l.weight * 2.0)));
    // Curve each link so the rendering looks like axons + dendrites rather
    // than billiard-ball straight lines. Multi-edges between the same node
    // pair get distinct curvatures + rotations (see computeEdgeShapes).
    g.linkCurvature((l: AtlasLink) => this.edgeShape.get(l.id)?.curvature ?? 0.1);
    g.linkCurveRotation((l: AtlasLink) => this.edgeShape.get(l.id)?.rotation ?? 0);
    g.linkDirectionalArrowLength((l: AtlasLink) => l.directed ? Math.max(3, Math.min(10, 2 + l.weight * 4.5)) : 0);
    g.linkDirectionalArrowRelPos(0.94);
    g.linkDirectionalArrowColor((l: AtlasLink) => this.colorForLink(l));
    // Flowing particles along directional links — neural-pulse effect that
    // makes "this memory points to that one" feel alive. We control
    // visibility via the COUNT (not just color), because three-forcegraph
    // renders particles as Sprite materials whose opacity ignores the
    // alpha channel of the color string. Returning 0 here is the only
    // reliable way to hide a pulse on a non-incident edge during selection
    // / hover focus.
    g.linkDirectionalParticles((l: AtlasLink) => this.particleCountFor(l));
    g.linkDirectionalParticleSpeed((l: AtlasLink) => 0.004 + Math.min(0.018, l.weight * 0.006));
    g.linkDirectionalParticleColor((l: AtlasLink) => this.brightParticleColor(l));
    g.linkDirectionalParticleWidth(2.6);

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
    g.cooldownTicks(this.opts.compact ? 120 : 1200);
    g.warmupTicks(this.opts.compact ? 20 : 80);

    // Constant inertia for the main renderer: every 4 seconds, nudge the
    // simulation's alpha back up. Combined with the slow alpha decay above,
    // the graph settles toward equilibrium for ~3s, gets gently kicked,
    // settles again — produces a continuous breathing motion without
    // burning constant CPU on a fully-hot simulation.
    if (!this.opts.compact) {
      this.startReheatLoop();
    }

    if (!this.opts.compact) {
      // Per-link spring physics — heavier edges become stiffer springs and
      // longer at rest. Strength is dynamic so dragging boosts the pull
      // on a node's neighbors, making the graph follow the drag elastically
      // instead of lagging behind it. All values are deliberately gentle:
      // loose springs let the many-body repulsion + collision force push
      // dense clusters apart instead of yanking them inward.
      const linkForce = g.d3Force('link') as
        | undefined
        | { strength?: (fn: (l: AtlasLink) => number) => unknown; distance?: (fn: (l: AtlasLink) => number) => unknown };
      if (linkForce?.strength && linkForce?.distance) {
        linkForce.strength((l: AtlasLink) => {
          const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
          const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
          // Lowered cap (was 0.85) and base (was 0.18) so springs are
          // looser — repulsion has room to breathe within dense hub
          // clusters, instead of getting overpowered by 10+ stiff springs
          // all pulling toward the same hub node.
          const base = Math.min(0.55, 0.08 + l.weight * 0.35);
          if (this.draggingId && (sId === this.draggingId || tId === this.draggingId)) {
            return Math.min(0.85, base * 1.6);
          }
          return base;
        });
        // Bigger rest length (was Math.max(8, 22/weight); now 18 + 30/weight)
        // so even single-edge connections sit further apart by default.
        linkForce.distance((l: AtlasLink) => {
          const base = 18 + Math.min(40, 30 / Math.max(0.3, l.weight));
          return base * this.layoutScale;
        });
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
    }

    if (this.opts.compact) {
      g.linkDirectionalParticles(0);
      g.enableNodeDrag(false);
      g.enableNavigationControls(false);
    } else {
      g.enableNodeDrag(true);
      // Disable trackball's built-in wheel zoom — we replace it with a
      // cursor-aware lerp below. Trackball's default zoom dollies along
      // the camera direction toward the FIXED target; we want zoom to
      // converge on whatever the cursor is hovering over.
      const ctrls = g.controls() as {
        noZoom?: boolean;
        zoomSpeed?: number;
        staticMoving?: boolean;
        dynamicDampingFactor?: number;
        rotateSpeed?: number;
        addEventListener?: (type: string, fn: () => void) => void;
      };
      if (ctrls) {
        ctrls.noZoom = true;
        // Some control implementations honor zoomSpeed=0 instead of noZoom.
        ctrls.zoomSpeed = 0;
        // Camera-fling momentum: staticMoving=false enables the inertia
        // that keeps the camera rotating after the user releases the mouse.
        // dynamicDampingFactor controls how quickly that velocity decays —
        // lower = longer coast. 0.05 gives a meaningful "you spun the
        // graph and it kept going" feel without taking forever to settle.
        ctrls.staticMoving = false;
        ctrls.dynamicDampingFactor = 0.05;
        // Default rotateSpeed (1.0) feels a bit slow for trackball; bump
        // so a small wrist flick produces a satisfying spin.
        ctrls.rotateSpeed = 1.6;
        // Pause the "alive" reheat loop during active orbit. The library's
        // TrackballControls fires DOM-style 'start' and 'end' events on
        // every drag gesture — start on pointerdown-with-drag, end on
        // pointerup. We piggyback on those to flip isOrbiting; the reheat
        // loop checks the flag.
        ctrls.addEventListener?.('start', () => {
          this.isOrbiting = true;
          // Lazy orbit-pivot snap: if a node is selected, set the trackball
          // target to its position right as the user begins the rotation
          // gesture. The camera adjustment happens DURING the drag so it
          // reads as part of the rotation, not as a separate "centering"
          // animation triggered by clicking. This is the key to the
          // user's request: clicks don't center, but rotations do pivot
          // around the selected node.
          if (this.selectedId !== null) {
            const node = this.allNodes.find((n) => n.id === this.selectedId);
            if (node) this.setOrbitPivotTo(node);
          }
        });
        ctrls.addEventListener?.('end', () => { this.isOrbiting = false; });

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
        // Ctrl/Cmd + left-drag also pans. We toggle LEFT's mapping while
        // the modifier is held. window-level so the user can press the
        // key before clicking the canvas; cleanup happens in dispose().
        this.onModKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Control' || e.key === 'Meta') {
            if (mb) mb.LEFT = 2; // PAN
          }
        };
        this.onModKeyUp = (e: KeyboardEvent) => {
          if (e.key === 'Control' || e.key === 'Meta') {
            if (mb) mb.LEFT = 0; // ROTATE
          }
        };
        window.addEventListener('keydown', this.onModKeyDown);
        window.addEventListener('keyup', this.onModKeyUp);
        // Belt-and-suspenders: if the window loses focus while the user
        // is holding Ctrl, reset to ROTATE so they don't end up "stuck"
        // in pan mode next time they click.
        window.addEventListener('blur', () => { if (mb) mb.LEFT = 0; });
      }
      // We attach the custom wheel handler on the host container (not the
      // canvas the library injects, which can change identity) — passive:
      // false so we can preventDefault().
      this.opts.container.addEventListener('wheel', this.onWheel, { passive: false });
      // Mousemove suppressor — every pointer move over the canvas refreshes
      // the timestamp the reheat loop reads. Reading: "the user is
      // currently looking at something on the graph, don't shift it under
      // them." Cleared automatically as the timestamp ages past
      // SUPPRESS_AFTER_MOVE_MS in the reheat check.
      this.opts.container.addEventListener('pointermove', this.onPointerMove);
    }
  }

  /** Updates the mousemove timestamp the reheat loop reads. */
  private onPointerMove = (): void => {
    this.lastMouseMove = Date.now();
  };

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
    this.reheatInterval = setInterval(() => {
      // Hard kill-switch wins — user toggled motion OFF from the toolbar.
      if (!this.aliveEnabled) return;
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
    }, 4000);
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
    chargeForce?.strength?.(-90 * this.layoutScale);
    chargeForce?.distanceMax?.(300 * this.layoutScale);
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

    // No modifier → cursor-aware zoom (original behavior).
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);
    const camDir = new THREE.Vector3();
    cam.getWorldDirection(camDir);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir.clone().negate(), target);
    const cursorWorld = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, cursorWorld)) return;
    // Clamp the per-event delta so a single big mouse-wheel notch (often
    // 100+ px) doesn't snap, and a trackpad spike doesn't either.
    const clamped = Math.max(-60, Math.min(60, dy));
    // Linear scale: 1px of normalized scroll = 0.0015 of the cursor-target
    // distance. Sign flip: negative deltaY = scroll up = zoom in.
    const factor = -clamped * 0.0015;
    cam.position.lerp(cursorWorld, factor);
    target.lerp(cursorWorld, factor);
    ctrls.update?.();
  };

  private wireEvents(): void {
    const g = this.graph;
    g.onNodeClick((n: AtlasNode) => {
      // Toggle: clicking the same node a second time clears the selection.
      // Makes "give me my context back" a single-click action, same target
      // the user just looked at.
      if (this.selectedId === n.id) {
        this.selectedId = null;
        this.previewHighlightId = null;
        this.graph.refresh();
        this.opts.onSelect?.(null);
        return;
      }
      this.selectedId = n.id;
      this.previewHighlightId = null;
      // Deliberately DON'T move the orbit pivot here — that would force
      // the camera to swing to look at the node, which the user reads as
      // unwanted centering. The pivot gets snapped to the selected node
      // lazily at the start of the user's next orbit gesture (see the
      // controls 'start' event handler below). Result: click = silent
      // selection; subsequent orbit = pivots around the node.
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
      if (this.draggingId !== n.id) this.draggingId = n.id;
      // Keep alpha hot so the simulation actively integrates forces. Without
      // this, by the time the user has been dragging for a few seconds, the
      // sim has cooled and other nodes stop moving.
      this.graph.d3ReheatSimulation();
    });
    g.onNodeDragEnd((n: AtlasNode) => {
      this.draggingId = null;
      n.fx = n.x;
      n.fy = n.y;
      n.fz = n.z;
      // One last reheat so the release "settles in" with a bounce instead
      // of an instant freeze. Combined with the low decay constants, this
      // gives the springy oscillation around the new pinned position.
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

  setNodes(nodes: AtlasNode[]): void {
    this.allNodes = nodes.map((n) => ({ ...n }));
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
    // Re-apply forces that hold their value as a number (not an accessor):
    // charge strength and collision radius. Link distance / strength use
    // accessor closures that read layoutScale at simulation time, so they
    // pick up the new value automatically on the next tick.
    if (!this.opts.compact) {
      this.applyChargeForce();
      const collide = this.graph.d3Force('collide') as
        | undefined
        | { radius?: (fn: () => number) => unknown };
      collide?.radius?.(() => 14 * this.layoutScale);
    }
    // Initialize source-visibility map (existing keys preserved, new ones default-on).
    const seen = new Set<string>();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      seen.add(key);
      if (!this.sourceVisible.has(key)) this.sourceVisible.set(key, true);
    }
    // Drop sources that no longer exist.
    for (const key of [...this.sourceVisible.keys()]) {
      if (!seen.has(key)) this.sourceVisible.delete(key);
    }

    this.refreshGraph();
    // Belt-and-suspenders: if the container had no dimensions when we
    // constructed (e.g., the pane was display:none) the library's internal
    // canvas can stay at 0×0. Re-apply size on every data swap so render
    // ticks always have correct WebGL viewport dimensions.
    this.applySize();
    // Kick the simulation so the new scaling actually expands the layout
    // instead of letting it sit at the old positions until the user nudges
    // something.
    this.graph.d3ReheatSimulation();
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
    this.allLinks = out;
    this.computeEdgeShapes();
    this.computeNodeDegrees();
    this.refreshGraph();
  }

  /**
   * Aggregate incident edge weights per node. Both endpoints of every link
   * accumulate the link's weight — undirected and directed contribute
   * equally. The result drives node size in `nodeVal`.
   */
  private computeNodeDegrees(): void {
    this.nodeDegree.clear();
    for (const l of this.allLinks) {
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
  private computeEdgeShapes(): void {
    this.edgeShape.clear();
    const buckets = new Map<string, AtlasLink[]>();
    for (const l of this.allLinks) {
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      const key = sId < tId ? `${sId}|${tId}` : `${tId}|${sId}`;
      const arr = buckets.get(key);
      if (arr) arr.push(l);
      else buckets.set(key, [l]);
    }
    const baselineCurve = 0.12;       // single edges still get a gentle organic curve
    const multiCurve = 0.35;          // bow magnitude for edges in a multi-bundle
    for (const arr of buckets.values()) {
      if (arr.length === 1) {
        const link = arr[0] as AtlasLink;
        this.edgeShape.set(link.id, { curvature: baselineCurve, rotation: 0 });
        continue;
      }
      // Stable order: directed first, then by id. Same order across re-renders
      // gives the user a consistent layout when they look back.
      arr.sort((a, b) => {
        if (a.directed !== b.directed) return a.directed ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
      // Trick to make multi-edges visually distinct rather than mirrored:
      //   - SAME curvature magnitude for every edge in the bundle.
      //   - DIFFERENT rotations around the source-target axis, evenly
      //     distributed across the full circle. Each curve bows away from
      //     the axis in a perpendicular plane, so the bundle reads like
      //     N parallel routes wrapped around a cylinder — not as N mirror
      //     images stacked at the same place.
      //
      // For the common case of exactly two edges (one directed, one
      // undirected) this places them 90° apart in 3D, which is the maximum
      // visual separation you can achieve while keeping both endpoints
      // anchored at the same node centers.
      for (let i = 0; i < arr.length; i++) {
        const link = arr[i] as AtlasLink;
        const rotation = arr.length === 2
          ? (i === 0 ? 0 : Math.PI / 2)                 // 0° and 90° for pairs
          : (i / arr.length) * Math.PI * 2;             // even fan for 3+
        this.edgeShape.set(link.id, { curvature: multiCurve, rotation });
      }
    }
  }

  /** Pushes the filtered node/edge set into the graph instance. */
  private refreshGraph(): void {
    const visibleNodes = this.allNodes.filter((n) => this.sourceVisible.get(n.sourceFile ?? '') ?? true);
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleLinks = this.allLinks.filter((l) =>
      visibleIds.has(typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id) &&
      visibleIds.has(typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id) &&
      this.categoryVisible[l.category],
    );
    this.graph.graphData({ nodes: visibleNodes, links: visibleLinks });
  }

  /** Frame the camera so the full cloud fits in view. */
  zoomToFit(ms = 800, padding = 80): void {
    this.graph.zoomToFit(ms, padding);
  }

  // ── Filters (UI calls these from the legend) ─────────────────────────

  setCategoryVisible(category: EdgeCategory, visible: boolean): void {
    this.categoryVisible[category] = visible;
    this.refreshGraph();
  }
  getCategoryVisibility(): Record<EdgeCategory, boolean> { return { ...this.categoryVisible }; }

  setSourceVisible(sourceKey: string, visible: boolean): void {
    this.sourceVisible.set(sourceKey, visible);
    this.refreshGraph();
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
        label: key ? (key.split('/').pop() ?? key) : '(no source)',
        color: colorForSource(key || undefined),
        nodeCount: count,
        visible: this.sourceVisible.get(key) ?? true,
      }));
  }

  edgeCounts(): Record<EdgeCategory, number> {
    const out: Record<EdgeCategory, number> = {
      reasoning: 0, structure: 0, social: 0, temporal: 0, semantic: 0, identity: 0,
    };
    for (const l of this.allLinks) out[l.category] += 1;
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
    if (!ctrls?.target || typeof ctrls.target.set !== 'function') return;
    ctrls.target.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
    ctrls.update?.();
  }

  /**
   * Center the camera on a node AND emphasize its neighbors. Used when
   * the user explicitly asks to navigate (e.g., clicking a node from the
   * Overview mini-atlas → jump into the full Graphnosis pane on that node).
   * For sidebar-driven navigation use `select()` instead.
   */
  focus(nodeId: string): void {
    const node = this.allNodes.find((n) => n.id === nodeId);
    if (!node) return;
    this.selectedId = nodeId;
    // Compute a camera position offset along the look-at vector.
    const x = node.x ?? 0, y = node.y ?? 0, z = node.z ?? 0;
    const dist = 40;
    // Distance-from-origin direction; if the node is at origin, use a default.
    const r = Math.sqrt(x * x + y * y + z * z) || 1;
    const ratio = (r + dist) / r;
    this.graph.cameraPosition(
      { x: x * ratio, y: y * ratio, z: z * ratio },
      { x, y, z } as { x: number; y: number; z: number },
      900,
    );
    // Re-render with neighbor emphasis applied via color callbacks.
    this.graph.refresh();
  }

  resetEmphasis(): void {
    this.selectedId = null;
    this.previewHighlightId = null;
    this.graph.refresh();
  }

  /**
   * Transient hover highlight, called by the inspector when the user hovers
   * a connection row. Pass `null` to clear. Doesn't move the camera and
   * doesn't disturb the click-selection state — it's a pure visual preview
   * that ends as soon as the mouse leaves the row.
   */
  previewHighlight(nodeId: string | null): void {
    if (this.previewHighlightId === nodeId) return;
    this.previewHighlightId = nodeId;
    // Force re-render so the accessors (nodeVal, nodeColor, linkColor) are
    // re-evaluated with the new previewHighlightId.
    this.graph.refresh();
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
      // Optional: don't ALSO reheat here — just let the current alpha
      // decay to zero on its own. The user wanted a stop, so respect it.
    } else {
      // Re-energize immediately so the user sees the motion return.
      this.graph.d3ReheatSimulation();
    }
    return this.aliveEnabled;
  }
  isAliveEnabled(): boolean { return this.aliveEnabled; }

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
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      if (sId !== nodeId && tId !== nodeId) continue;
      const neighborId = sId === nodeId ? tId : sId;
      const direction: 'out' | 'in' | 'undirected' = !l.directed ? 'undirected' : sId === nodeId ? 'out' : 'in';
      out.push({ neighborId, type: l.type, category: l.category, direction, weight: l.weight });
    }
    return out.sort((a, b) => a.category.localeCompare(b.category) || b.weight - a.weight);
  }

  dispose(): void {
    this.resizeObs?.disconnect();
    if (this.reheatInterval !== null) {
      clearInterval(this.reheatInterval);
      this.reheatInterval = null;
    }
    if (!this.opts.compact) {
      this.opts.container.removeEventListener('wheel', this.onWheel);
      this.opts.container.removeEventListener('pointermove', this.onPointerMove);
      if (this.onModKeyDown) window.removeEventListener('keydown', this.onModKeyDown);
      if (this.onModKeyUp) window.removeEventListener('keyup', this.onModKeyUp);
    }
    // 3d-force-graph exposes _destructor on the instance.
    const inst = this.graph as unknown as { _destructor?: () => void };
    inst._destructor?.();
  }

  // ── Color helpers (with neighbor-dimming when a node is selected) ────

  private colorForNode(n: AtlasNode): string {
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
    if (this.previewHighlightId !== null && this.selectedId !== null) {
      if (n.id === this.selectedId || n.id === this.previewHighlightId) {
        return this.applyAlpha(this.brighten(base, 0.25), 1.0);
      }
      return this.applyAlpha(base, 0.08);
    }

    // NEUTRAL — nothing selected. Every node at full opacity, no confidence
    // dimming. The graph reads as "all here, no focus yet."
    if (this.selectedId === null) {
      return this.applyAlpha(base, 1.0);
    }

    // SELECTION — the selected node AND its connected neighbors all read
    // as fully bright; everything else fades hard so the "neighborhood of
    // this memory" is unambiguous.
    if (n.id === this.selectedId) return this.applyAlpha(base, 1.0);
    if (this.isNeighborOf(n.id, this.selectedId)) return this.applyAlpha(base, 1.0);
    return this.applyAlpha(base, 0.08);
  }

  private colorForLink(l: AtlasLink): string {
    const base = CATEGORY_COLOR[l.category];
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;

    // HOVER MODE — only the edge(s) connecting the selected node to the
    // hovered neighbor are bright. Multiple edges between the same pair
    // (directed + undirected) all qualify. Everything else dims hard.
    if (this.previewHighlightId !== null && this.selectedId !== null) {
      const isTheConnection =
        (sId === this.selectedId && tId === this.previewHighlightId) ||
        (sId === this.previewHighlightId && tId === this.selectedId);
      if (isTheConnection) return this.applyAlpha(this.brighten(base, 0.25), 1.0);
      return this.applyAlpha(base, 0.04);
    }

    // NEUTRAL — every edge at full color, no dimming.
    if (this.selectedId === null) return this.applyAlpha(base, 1.0);

    // SELECTION — incident edges bright, others dim.
    const connected = sId === this.selectedId || tId === this.selectedId;
    return this.applyAlpha(base, connected ? 0.95 : 0.08);
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
    if (!l.directed) return 0;
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;

    if (this.previewHighlightId !== null && this.selectedId !== null) {
      const isTheConnection =
        (sId === this.selectedId && tId === this.previewHighlightId) ||
        (sId === this.previewHighlightId && tId === this.selectedId);
      return isTheConnection ? 2 : 0;
    }

    if (this.selectedId !== null) {
      return (sId === this.selectedId || tId === this.selectedId) ? 2 : 0;
    }

    return 2;
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
    const base = CATEGORY_COLOR[l.category];
    const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;

    // HOVER MODE — only the one hovered connection's particles glow.
    if (this.previewHighlightId !== null && this.selectedId !== null) {
      const isTheConnection =
        (sId === this.selectedId && tId === this.previewHighlightId) ||
        (sId === this.previewHighlightId && tId === this.selectedId);
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

  private isNeighborOf(candidateId: string, selectedId: string): boolean {
    for (const l of this.allLinks) {
      const sId = typeof l.source === 'string' ? l.source : (l.source as AtlasNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as AtlasNode).id;
      if ((sId === selectedId && tId === candidateId) || (tId === selectedId && sId === candidateId)) return true;
    }
    return false;
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
