// ── Engram Engine #2: deck.gl ──────────────────────────────────────
//
// GPU-first viz from Uber, designed to scale to 1M+ nodes interactively.
// Uses ScatterplotLayer (instanced point sprites) for nodes and LineLayer
// for edges. Both layers do their per-instance work on the GPU — the
// JS side only sends position/color arrays, not per-frame geometry.
//
// Renders as a 3D pseudo-perspective view via OrbitView. Mouse drag
// rotates (alt+drag pans), wheel zooms. Click → pick → select.
//
// What this engine does that Engine #1 doesn't:
//   - GPU-only rendering — no Three.js scene graph overhead
//   - ScatterplotLayer is *visually clean* (smooth antialiased circles)
//     compared to icosahedrons
//   - Picking is GPU-side and constant-time regardless of N
//   - Designed for 100K+ nodes from the start
//
// What this engine doesn't do (yet):
//   - Hover tooltip — deck.gl emits onHover; we wire it to the App's
//     existing tooltip pattern, simple addition
//   - Per-edge thickness by weight — possible via getWidth accessor
//   - Curved edges, particles, arrows — not in this build
//
// Positions are pre-computed via the same physics worker as Engine #1.
// On filter changes, only the visible-data subset is re-pushed to deck;
// no re-layout.

import { Deck, LightingEffect, AmbientLight, DirectionalLight } from '@deck.gl/core';
import { OrbitView } from '@deck.gl/core';
import { LineLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import {
  CATEGORY_COLOR,
  categoryFor,
  type AtlasNode,
  type AtlasDirectedEdge,
  type AtlasUndirectedEdge,
  type EdgeCategory,
  type AtlasOptions,
} from './atlas.js';
import type {
  AtlasEngine,
  AtlasEngineKind,
  SourceInfo,
  NodeConnection,
} from './atlas-engine.js';
import PhysicsWorker from './engine-three-physics-worker.ts?worker';

interface DeckNode extends AtlasNode {
  position: [number, number, number];
}

interface DeckLink {
  id: string;
  source: string;
  target: string;
  directed: boolean;
  type: string;
  category: EdgeCategory;
  weight: number;
  sourcePosition: [number, number, number];
  targetPosition: [number, number, number];
}

/** Stable color for a source-file string — same FNV-1a hash as Engine #1
 *  so legends agree across engines. Returns [r, g, b] in 0-255. */
function colorForSource(sourceFile: string): [number, number, number] {
  if (!sourceFile) return [154, 160, 170];
  let h = 0x811c9dc5;
  for (let i = 0; i < sourceFile.length; i++) {
    h ^= sourceFile.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  return hslToRgb(hue / 360, 0.55, 0.6);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

export class EngramEngineDeckGL implements AtlasEngine {
  readonly kind: AtlasEngineKind = 'force-3d' as AtlasEngineKind; // legacy stub, no longer active

  private container: HTMLElement;
  private onSelect?: (node: AtlasNode | null) => void;
  private canvas: HTMLCanvasElement;
  // Deck<OrbitView> — typed narrowly so setProps accepts OrbitViewState.
  private deck: Deck<OrbitView>;
  private resizeObserver: ResizeObserver | null = null;

  // Tooltip overlay
  private tooltipEl: HTMLDivElement;
  private hoveredId: string | null = null;

  // Data
  private allNodes: AtlasNode[] = [];
  private allLinks: DeckLink[] = [];
  private positions = new Map<string, [number, number, number]>();

  // Filters
  private sourceVisible = new Map<string, boolean>();
  private categoryVisible: Record<EdgeCategory, boolean> = {
    reasoning: true, structure: true, social: true,
    temporal: true, semantic: true, identity: true, predicted: true,
  };

  // Selection
  private selectedId: string | null = null;
  private neighborsOfSelected: Set<string> | null = null;

  // View state — pan/zoom/rotation. Deck.gl wants this passed in on
  // every update; we keep it in sync via onViewStateChange.
  private viewState = {
    target: [0, 0, 0] as [number, number, number],
    rotationOrbit: 30,
    rotationX: 30,
    zoom: 0,   // auto-zoom fires when physics settles; start neutral
    minZoom: -3,
    maxZoom: 10,
  };

  // Physics worker
  private physicsWorker: Worker | null = null;
  private lastPositionApplyAt = 0;
  private hasAutoFitted = false;

  // Sphere mesh shared across all node instances (1 geometry, N draws).
  private sphereMesh = new SphereGeometry({ radius: 1, nlat: 12, nlong: 16 });

  constructor(opts: AtlasOptions) {
    this.container = opts.container;
    if (opts.onSelect) this.onSelect = opts.onSelect;

    // Container needs position:relative for absolute children.
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }

    // ── Canvas + tooltip overlay ─────────────────────────────────
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
    } as Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.canvas);

    this.tooltipEl = document.createElement('div');
    Object.assign(this.tooltipEl.style, {
      position: 'absolute',
      pointerEvents: 'none',
      padding: '6px 9px',
      background: 'rgba(20, 20, 24, 0.94)',
      color: '#e7e7eb',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '6px',
      fontSize: '12px',
      lineHeight: '1.4',
      maxWidth: '320px',
      zIndex: '10',
      opacity: '0',
      transition: 'opacity 90ms',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
    } as Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.tooltipEl);

    // ── Lighting ─────────────────────────────────────────────────
    // SimpleMeshLayer responds to lighting — gives depth shading on
    // the sphere geometries. Without this the spheres render flat-shaded
    // (single color) and look 2D regardless of camera angle.
    const lightingEffect = new LightingEffect({
      ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.55 }),
      key: new DirectionalLight({
        color: [255, 255, 255],
        intensity: 1.6,
        direction: [-1, -1, -1],
      }),
      rim: new DirectionalLight({
        color: [127, 187, 255],
        intensity: 0.55,
        direction: [1, 0.5, 1],
      }),
    });

    // ── Deck.gl instance ─────────────────────────────────────────
    // Three key design decisions here:
    //
    // 1. `views: new OrbitView(...)` — singular, NOT an array. With an
    //    array, deck.gl expects viewState wrapped as { [viewId]: state };
    //    a singular View lets viewState be a plain OrbitViewState object.
    //
    // 2. `viewState` (not `initialViewState`) — fully controlled mode.
    //    Using initialViewState then calling setProps({ viewState }) later
    //    triggers deck.gl's "view state tracking disabled" warning and
    //    freezes the camera. Controlled mode from the start avoids this.
    //
    // 3. `onViewStateChange` only updates this.viewState + pushes back the
    //    new view state via setProps. It does NOT call refreshDeck() (which
    //    would rebuild all layers on every mouse-move — wasteful).
    this.deck = new Deck({
      canvas: this.canvas,
      views: new OrbitView({ orbitAxis: 'Y', fovy: 50, controller: true }),
      viewState: this.viewState,
      effects: [lightingEffect],
      onViewStateChange: ({ viewState }) => {
        this.viewState = viewState as typeof this.viewState;
        // Camera-only update — no layer rebuild needed.
        this.deck.setProps({ viewState: this.viewState });
      },
      onClick: (info) => {
        const node = info.object as DeckNode | undefined;
        if (node) this.select(node.id);
        else this.resetEmphasis();
      },
      onHover: (info) => {
        this.handleHover(info.object as DeckNode | undefined, info.x, info.y);
      },
      layers: [],
    });

    // ── Resize handling ──────────────────────────────────────────
    this.resizeObserver = new ResizeObserver(() => {
      // deck.gl auto-reads canvas clientWidth/clientHeight on redraw.
      this.deck.redraw('resize');
    });
    this.resizeObserver.observe(this.container);
  }

  // ── Data ───────────────────────────────────────────────────────

  setNodes(nodes: AtlasNode[]): void {
    this.allNodes = nodes.map((n) => ({ ...n }));

    // Source visibility map upkeep
    const seen = new Set<string>();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      seen.add(key);
      if (!this.sourceVisible.has(key)) this.sourceVisible.set(key, true);
    }
    for (const key of [...this.sourceVisible.keys()]) {
      if (!seen.has(key)) this.sourceVisible.delete(key);
    }

    // Seed positions for new nodes — small random offsets so they don't
    // stack at the origin while the worker runs.
    for (const n of this.allNodes) {
      if (!this.positions.has(n.id)) {
        this.positions.set(n.id, [
          (Math.random() - 0.5) * 40,
          (Math.random() - 0.5) * 40,
          (Math.random() - 0.5) * 40,
        ]);
      }
    }
    // Drop positions for nodes that no longer exist.
    const liveIds = new Set(this.allNodes.map((n) => n.id));
    for (const id of [...this.positions.keys()]) {
      if (!liveIds.has(id)) this.positions.delete(id);
    }

    this.startWorkerLayout();
    this.refreshDeck();
  }

  setEdges(directed: AtlasDirectedEdge[], undirected: AtlasUndirectedEdge[]): void {
    const validIds = new Set(this.allNodes.map((n) => n.id));
    const out: DeckLink[] = [];
    for (const d of directed) {
      if (!validIds.has(d.from) || !validIds.has(d.to)) continue;
      const sp = this.positions.get(d.from) ?? [0, 0, 0];
      const tp = this.positions.get(d.to) ?? [0, 0, 0];
      out.push({
        id: `d:${d.id}`,
        source: d.from,
        target: d.to,
        directed: true,
        type: d.type,
        category: categoryFor(true, d.type),
        weight: d.weight,
        sourcePosition: [...sp],
        targetPosition: [...tp],
      });
    }
    for (const u of undirected) {
      if (!validIds.has(u.a) || !validIds.has(u.b)) continue;
      const sp = this.positions.get(u.a) ?? [0, 0, 0];
      const tp = this.positions.get(u.b) ?? [0, 0, 0];
      out.push({
        id: `u:${u.id}`,
        source: u.a,
        target: u.b,
        directed: false,
        type: u.type,
        category: categoryFor(false, u.type),
        weight: u.weight,
        sourcePosition: [...sp],
        targetPosition: [...tp],
      });
    }
    this.allLinks = out;
    this.refreshDeck();
  }

  getNodes(): AtlasNode[] { return this.allNodes; }

  // ── Worker-driven async layout ─────────────────────────────────

  private startWorkerLayout(): void {
    if (this.physicsWorker) {
      this.physicsWorker.postMessage({ type: 'abort' });
      this.physicsWorker.terminate();
      this.physicsWorker = null;
    }
    this.hasAutoFitted = false;

    const worker = new PhysicsWorker();
    this.physicsWorker = worker;
    const nodeOrder = this.allNodes.map((n) => n.id);

    worker.onmessage = (e: MessageEvent<{
      type: 'tick' | 'done';
      positions: Float32Array;
    }>): void => {
      const { type, positions } = e.data;
      const isFinal = type === 'done';
      if (isFinal) this.lastPositionApplyAt = 0;
      this.applyPositionsFromWorker(nodeOrder, positions);
      if (isFinal) {
        worker.terminate();
        if (this.physicsWorker === worker) this.physicsWorker = null;
        if (!this.hasAutoFitted) {
          this.hasAutoFitted = true;
          this.zoomToFit(1000);
        }
      }
    };

    const initNodes = this.allNodes.map((n) => {
      const cached = this.positions.get(n.id);
      return cached
        ? { id: n.id, x: cached[0], y: cached[1], z: cached[2] }
        : { id: n.id };
    });
    const initLinks = this.allLinks.map((l) => ({
      source: l.source,
      target: l.target,
      weight: l.weight,
    }));
    worker.postMessage({
      type: 'init',
      nodes: initNodes,
      links: initLinks,
      // Slower alphaDecay in the worker needs more ticks to reach
      // settled state. 800 lets the spatial layout fully resolve.
      maxTicks: 800,
      batchSize: 6,
    });
  }

  private applyPositionsFromWorker(nodeOrder: string[], positions: Float32Array): void {
    const now = performance.now();
    if (now - this.lastPositionApplyAt < 33) return;
    this.lastPositionApplyAt = now;

    for (let i = 0; i < nodeOrder.length; i++) {
      const id = nodeOrder[i] as string;
      const x = positions[i * 3 + 0] as number;
      const y = positions[i * 3 + 1] as number;
      const z = positions[i * 3 + 2] as number;
      this.positions.set(id, [x, y, z]);
    }

    // Update link endpoint positions to track moved nodes.
    for (const l of this.allLinks) {
      const sp = this.positions.get(l.source);
      const tp = this.positions.get(l.target);
      if (sp) l.sourcePosition = [...sp];
      if (tp) l.targetPosition = [...tp];
    }

    this.refreshDeck();
  }

  // ── Render ─────────────────────────────────────────────────────

  private refreshDeck(): void {
    const visibleNodes: DeckNode[] = this.allNodes
      .filter((n) => this.sourceVisible.get(n.sourceFile ?? '') ?? true)
      .map((n) => ({
        ...n,
        position: this.positions.get(n.id) ?? [0, 0, 0],
      }));

    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleLinks = this.allLinks.filter(
      (l) =>
        this.categoryVisible[l.category] &&
        visibleIds.has(l.source) &&
        visibleIds.has(l.target),
    );

    const hasSel = this.selectedId !== null;
    const sel = this.selectedId;
    const neighbors = this.neighborsOfSelected;

    // SimpleMeshLayer renders an instance of `sphereMesh` at each
    // position with per-instance translation, scale, and color. Unlike
    // ScatterplotLayer (flat circles), this responds to the
    // LightingEffect → proper 3D shading → real spatial perception.
    //
    // sizeScale: 4 — matches vasturiano's nodeRelSize:4 default so nodes
    // are visible at typical camera distances. With SphereGeometry radius=1
    // and per-node getScale ≈ [1.26], effective radius ≈ 5 world units,
    // which renders as ~20px diameter at typical zoom levels.
    const nodeLayer = new SimpleMeshLayer<DeckNode>({
      id: 'nodes',
      data: visibleNodes,
      pickable: true,
      mesh: this.sphereMesh,
      getPosition: (d) => d.position,
      getColor: (d) => {
        const [r, g, b] = colorForSource(d.sourceFile ?? '');
        if (!hasSel || sel === d.id || neighbors?.has(d.id)) return [r, g, b];
        return [Math.round(r * 0.25), Math.round(g * 0.25), Math.round(b * 0.25)];
      },
      sizeScale: 4,
      getTranslation: () => [0, 0, 0] as [number, number, number],
      getScale: (d) => {
        const base = 0.5 + d.confidence * 0.8;
        let mul = 1.4;
        if (sel === d.id) mul = 2.6;
        else if (neighbors?.has(d.id)) mul = 1.8;
        return [base * mul, base * mul, base * mul] as [number, number, number];
      },
      material: {
        ambient: 0.4,
        diffuse: 0.8,
        shininess: 32,
        specularColor: [255, 255, 255],
      },
      updateTriggers: {
        getScale: [sel, neighbors],
        getColor: [sel, neighbors],
      },
    });

    const linkLayer = new LineLayer<DeckLink>({
      id: 'links',
      data: visibleLinks,
      pickable: false,
      getSourcePosition: (d) => d.sourcePosition,
      getTargetPosition: (d) => d.targetPosition,
      getColor: (d) => {
        const [r, g, b] = hexToRgb(CATEGORY_COLOR[d.category]);
        const incident = hasSel && (d.source === sel || d.target === sel);
        if (!hasSel || incident) return [r, g, b, 200];
        return [Math.round(r * 0.25), Math.round(g * 0.25), Math.round(b * 0.25), 100];
      },
      getWidth: (d) => 0.6 + d.weight * 1.4,
      widthUnits: 'pixels',
      updateTriggers: {
        getColor: [sel],
      },
    });

    this.deck.setProps({
      viewState: this.viewState,
      layers: [linkLayer, nodeLayer], // nodes on top
    });
  }

  // ── Selection / focus ──────────────────────────────────────────

  select(nodeId: string): void {
    if (this.selectedId === nodeId) {
      this.selectedId = null;
      this.neighborsOfSelected = null;
      this.refreshDeck();
      this.onSelect?.(null);
      return;
    }
    this.selectedId = nodeId;
    this.neighborsOfSelected = this.computeNeighbors(nodeId);
    this.refreshDeck();
    const node = this.allNodes.find((n) => n.id === nodeId);
    this.onSelect?.(node ?? null);
  }

  focus(nodeId: string): void {
    const pos = this.positions.get(nodeId);
    if (!pos) return;
    this.selectedId = nodeId;
    this.neighborsOfSelected = this.computeNeighbors(nodeId);
    // Animate camera target to the node.
    this.viewState = {
      ...this.viewState,
      target: [pos[0], pos[1], pos[2]],
    };
    this.refreshDeck();
  }

  resetEmphasis(): void {
    this.selectedId = null;
    this.neighborsOfSelected = null;
    this.refreshDeck();
  }

  previewHighlight(_nodeId: string | null): void { /* not implemented */ }

  private computeNeighbors(nodeId: string): Set<string> {
    const set = new Set<string>();
    for (const l of this.allLinks) {
      if (l.source === nodeId) set.add(l.target);
      else if (l.target === nodeId) set.add(l.source);
    }
    return set;
  }

  // ── Filters ────────────────────────────────────────────────────

  setCategoryVisible(category: EdgeCategory, visible: boolean): void {
    this.categoryVisible[category] = visible;
    this.refreshDeck();
  }

  getCategoryVisibility(): Record<EdgeCategory, boolean> {
    return { ...this.categoryVisible };
  }

  setSourceVisible(sourceKey: string, visible: boolean): void {
    this.sourceVisible.set(sourceKey, visible);
    this.refreshDeck();
  }

  sourcesWithCounts(): SourceInfo[] {
    const counts = new Map<string, number>();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const out: SourceInfo[] = [];
    for (const [key, nodeCount] of counts) {
      const [r, g, b] = colorForSource(key);
      out.push({
        key,
        label: key || '(unsourced)',
        color: (r << 16) | (g << 8) | b,
        nodeCount,
        visible: this.sourceVisible.get(key) ?? true,
      });
    }
    return out.sort((a, b) => b.nodeCount - a.nodeCount);
  }

  edgeCounts(): Record<EdgeCategory, number> {
    const out: Record<EdgeCategory, number> = {
      reasoning: 0, structure: 0, social: 0,
      temporal: 0, semantic: 0, identity: 0, predicted: 0,
    };
    for (const l of this.allLinks) out[l.category]++;
    return out;
  }

  // ── View ───────────────────────────────────────────────────────

  zoomToFit(_ms = 800, _padding = 20): void {
    if (this.allNodes.length === 0) return;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let any = false;
    for (const n of this.allNodes) {
      if (!(this.sourceVisible.get(n.sourceFile ?? '') ?? true)) continue;
      const p = this.positions.get(n.id);
      if (!p) continue;
      any = true;
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] > maxZ) maxZ = p[2];
    }
    if (!any) return;
    const target: [number, number, number] = [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    ];
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    // deck.gl OrbitView: projectionScale = 2^zoom / height. An object of
    // world-space width S fills S/height * 2^zoom of the viewport (at the
    // target plane). Solve for zoom so S fills 72% of viewport height:
    //   S / H * 2^zoom = 0.72  →  zoom = log2(H × 0.72 / S)
    const H = Math.max(this.container.getBoundingClientRect().height || 600, 200);
    const desiredZoom = Math.log2(Math.max(1, (H * 0.72) / Math.max(span, 1)));
    this.viewState = {
      ...this.viewState,
      target,
      zoom: Math.max(this.viewState.minZoom, Math.min(this.viewState.maxZoom, desiredZoom)),
    };
    this.refreshDeck();
  }

  pauseAnimation(): void { /* deck.gl redraws on demand; no continuous loop to pause */ }
  resumeAnimation(): void { /* same */ }

  // ── No-op motion (this engine has no continuous physics) ───────

  setAliveEnabled(_enabled: boolean): boolean { return false; }
  isAliveEnabled(): boolean { return false; }
  unpinAll(): void { /* no pins */ }
  reapplyPerfFlags(): void { /* not applicable */ }

  // ── Connections ────────────────────────────────────────────────

  getConnections(nodeId: string): NodeConnection[] {
    const out: NodeConnection[] = [];
    for (const l of this.allLinks) {
      if (l.source === nodeId) {
        out.push({
          neighborId: l.target,
          type: l.type,
          category: l.category,
          direction: l.directed ? 'out' : 'undirected',
          weight: l.weight,
        });
      } else if (l.target === nodeId) {
        out.push({
          neighborId: l.source,
          type: l.type,
          category: l.category,
          direction: l.directed ? 'in' : 'undirected',
          weight: l.weight,
        });
      }
    }
    return out;
  }

  // ── Hover ──────────────────────────────────────────────────────

  private handleHover(node: DeckNode | undefined, x: number, y: number): void {
    if (!node) {
      if (this.hoveredId !== null) {
        this.hoveredId = null;
        this.tooltipEl.style.opacity = '0';
      }
      return;
    }
    if (this.hoveredId !== node.id) {
      this.hoveredId = node.id;
      const text = node.text ?? '';
      const trimmed = text.length > 200 ? text.slice(0, 200) + '…' : text;
      this.tooltipEl.textContent = trimmed || '(no content)';
      this.tooltipEl.style.opacity = '1';
    }
    this.tooltipEl.style.left = `${x + 12}px`;
    this.tooltipEl.style.top = `${y + 14}px`;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  dispose(): void {
    if (this.physicsWorker) {
      this.physicsWorker.postMessage({ type: 'abort' });
      this.physicsWorker.terminate();
      this.physicsWorker = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.deck.finalize();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    if (this.tooltipEl.parentNode) this.tooltipEl.parentNode.removeChild(this.tooltipEl);
  }
}
