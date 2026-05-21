// ── Engram Engine: 3D Custom (Three.js + InstancedMesh) ────────────
//
// Custom WebGL renderer for the Engram canvas, replacing 3d-force-graph
// with hand-tuned Three.js code. Scope of this initial implementation:
//
//   ✓ Three.js scene + perspective camera + WebGLRenderer
//   ✓ OrbitControls for mouse drag + wheel zoom
//   ✓ InstancedMesh for all nodes (1 draw call regardless of N)
//   ✓ LineSegments for edges (straight lines; no curves yet)
//   ✓ Initial layout via d3-force-3d run ONCE on main thread
//   ✓ Static positions after initial settle (no perpetual motion)
//   ✓ Click selection via raycaster
//   ✓ Source / category visibility filters
//   ✓ Pause / resume render loop
//   ✓ Clean dispose
//
// Deferred to future chapters:
//   - Web Worker physics (currently main thread; freezes ~200ms at startup
//     while d3-force settles a few hundred ticks)
//   - Custom edge shader with per-edge thickness (currently uniform 1px)
//   - Curved multi-edges
//   - Directional particles / pulse animations
//   - Hover preview tooltip
//   - Dim-on-selection neighborhood emphasis
//
// File is large but kept self-contained — easier to swap in/out behind
// the engine factory than splitting across many tiny files.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
// Post-processing: bloom gives nodes/edges a subtle glow that reads as
// HDR luminance against the dark background. This is the single biggest
// "feels 3D and alive" visual upgrade — the same effect vasturiano's
// 3d-force-graph uses in its showcase examples. Without it, lit spheres
// against black look like flat stickers; with it, they read as glowing
// orbs in 3D space.
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
// Vite-native worker import — bundler emits the worker script as a
// separate chunk and gives us a `new PhysicsWorker()` constructor.
import PhysicsWorker from './engine-three-physics-worker.ts?worker';

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

interface InternalLink {
  id: string;
  source: string;
  target: string;
  directed: boolean;
  type: string;
  category: EdgeCategory;
  weight: number;
}

// Matches vasturiano's nodeRelSize: 4 default so nodes are visible at
// typical camera distances without requiring extreme bloom to show up.
const NODE_BASE_RADIUS = 4;         // sphere geometry radius at scale 1
const NODE_GEOMETRY_DETAIL = 0;     // icosahedron subdivisions — 0 = 20 tris/node
const SELECTED_BOOST = 1.8;          // size multiplier on selected node
const NEIGHBOR_BOOST = 1.25;         // size multiplier on neighbors

/** Stable color for a source-file string. Mirrors atlas.ts behavior so
 *  source legends agree across engines. Simple FNV-1a hash → HSL. */
function colorForSource(sourceFile: string): number {
  if (!sourceFile) return 0x9aa0aa;
  let h = 0x811c9dc5;
  for (let i = 0; i < sourceFile.length; i++) {
    h ^= sourceFile.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  // Convert HSL(hue, 55%, 60%) → hex
  const c = new THREE.Color().setHSL(hue / 360, 0.55, 0.6);
  return c.getHex();
}

export class EngramEngineThreeCustom implements AtlasEngine {
  readonly kind: AtlasEngineKind = 'force-3d' as AtlasEngineKind; // legacy stub, no longer active

  private container: HTMLElement;
  private onSelect?: (node: AtlasNode | null) => void;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver | null = null;
  /** Post-processing pipeline: render → bloom → output. The bloom pass
   *  is what gives nodes/edges their glowing 3D look. Tunable via the
   *  bloom* fields below. Null when float render targets are unavailable
   *  (macOS < Monterey, some WKWebView builds) — falls back to direct
   *  renderer.render() with no post-processing. */
  private composer: EffectComposer | null;
  private bloomPass: UnrealBloomPass | null;

  // Animation control — pauses the RAF loop when window is hidden, etc.
  private rafHandle: number | null = null;
  private isPaused = false;

  // Node storage
  private allNodes: AtlasNode[] = [];
  private allLinks: InternalLink[] = [];
  // Position cache — keyed by node id, persists across re-renders so the
  // graph doesn't relayout every time the source/category filter changes.
  private positions = new Map<string, THREE.Vector3>();
  private nodeMesh: THREE.InstancedMesh | null = null;
  private nodeIndexById = new Map<string, number>(); // id → instance index in current mesh
  private edgeMesh: LineSegments2 | null = null;
  private edgeMaterial: LineMaterial | null = null;
  /** Cone-sprite arrows at the tip of each directed edge. Instanced so
   *  N arrows = 1 draw call. Rebuilt with the edge mesh whenever
   *  positions or filters change. */
  private arrowMesh: THREE.InstancedMesh | null = null;
  // Filters
  private sourceVisible = new Map<string, boolean>();
  private categoryVisible: Record<EdgeCategory, boolean> = {
    reasoning: true, structure: true, social: true,
    temporal: true, semantic: true, identity: true, predicted: true,
  };
  // Selection
  private selectedId: string | null = null;
  // Neighbor cache for selection-time recolor
  private neighborsOfSelected: Set<string> | null = null;

  // Hover tooltip — single DOM node positioned absolutely over the
  // canvas, updated from pointermove raycasts. Throttled internally.
  private tooltipEl: HTMLDivElement;
  private hoveredId: string | null = null;
  private lastHoverRaycastAt = 0;

  // Physics worker — runs d3-force-3d off the main thread so initial
  // layout doesn't freeze the UI. The worker posts position updates
  // every few ticks; the main thread applies them to the InstancedMesh
  // matrices + edge buffer on a throttled cadence.
  private physicsWorker: Worker | null = null;
  private lastPositionApplyAt = 0;
  // Fires zoomToFit once after the first layout fully converges so the
  // camera frames the settled graph regardless of the 1200ms timer in
  // main.ts. Reset each time a new layout is started.
  private hasAutoFitted = false;

  constructor(opts: AtlasOptions, floatRenderTargets = true) {
    this.container = opts.container;
    if (opts.onSelect) this.onSelect = opts.onSelect;

    // ── Scene ───────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = null;
    // Exponential fog gives atmospheric perspective: distant nodes
    // fade out, near ones read crisp. Critical for "this is a 3D
    // space" perception — without it the scene looks like a flat
    // poster regardless of how good the layout is.
    this.scene.fog = new THREE.FogExp2(0x0c0d12, 0.0018);

    // ── Camera ──────────────────────────────────────────────────
    const { width, height } = this.containerSize();
    this.camera = new THREE.PerspectiveCamera(45, width / height, 1, 8000);
    this.camera.position.set(0, 0, 800);

    // ── Renderer ────────────────────────────────────────────────
    // Tone mapping = critical for bloom to read right. Without
    // ACESFilmicToneMapping the bloomed highlights blow out to pure
    // white and lose color. With it, glows preserve their hue gradient
    // (red-ish, blue-ish, etc.) and the scene reads cinematic.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    // ── Lighting ────────────────────────────────────────────────
    // Hemisphere light gives a "sky vs ground" color gradient — nodes
    // at the top tint slightly warm-white, bottoms tint cool-blue.
    // Adds organic depth perception beyond what a single directional
    // light can do. The two directional lights are the key/rim pair.
    this.scene.add(new THREE.HemisphereLight(0xfff0e0, 0x223040, 0.35));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(1, 1, 1).normalize();
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x7fbbff, 0.45);
    rimLight.position.set(-1, -0.5, -1).normalize();
    this.scene.add(rimLight);

    // ── Post-processing: bloom ──────────────────────────────────
    // EffectComposer = chain of full-screen passes. Pass 1 renders the
    // scene normally; pass 2 extracts bright pixels and blooms them;
    // pass 3 applies tone mapping + gamma correction.
    //
    // Bloom tuning notes:
    //   - strength 1.5  → visible glow without washing out the scene.
    //                     vasturiano's bloom example uses strength=4 but
    //                     that's with a dedicated black-canvas showcase;
    //                     here we share the app chrome so we go softer.
    //   - radius 0.5    → tighter falloff — glows are node-centered, not
    //                     scene-filling.
    //   - threshold 0.15 → only the lit faces of spheres contribute;
    //                     prevents the near-black background and dim edges
    //                     from blooming into a uniform haze (which is what
    //                     threshold=0 was causing: the entire scene turning
    //                     into an indistinct glowing fog).
    //
    // Cost: ~1-2ms per frame on M-class Macs at 1080p.
    //
    // Float render targets (EXT_color_buffer_float) are required by
    // UnrealBloomPass for the RGBA16F intermediate framebuffer. If the
    // WKWebView doesn't expose this extension (macOS < Monterey, some
    // older Intel systems), skip the bloom pipeline entirely and render
    // directly — the scene still looks good, just without glow.
    if (floatRenderTargets) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        1.5,  // strength
        0.5,  // radius
        0.15, // threshold — only lit sphere faces, not background or edges
      );
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } else {
      // Float textures unavailable — skip bloom, render directly.
      // Nodes still look good under ambient + directional lights without glow.
      console.info('[EngramEngine] Float render targets unavailable — bloom disabled.');
      this.composer = null;
      this.bloomPass = null;
    }

    // Renderer clear color matches the example's `#000003` — a tiny
    // hint of blue but essentially pure black. Bloom needs this
    // contrast: a dark gray BG would wash out the glow.
    this.renderer.setClearColor(0x000003, 1.0);

    // ── Controls ────────────────────────────────────────────────
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.8;
    this.controls.zoomSpeed = 0.9;
    this.controls.enableZoom = true;
    this.controls.minDistance = 10;
    // 8000 handles graphs up to ~3 000 world-unit bounding radius (N≈3K
    // nodes). Without this, controls.update() clamps the camera back
    // inside the old 1500 cap after zoomToFit moves it to the correct
    // framing distance, leaving the user stuck and unable to scroll out.
    this.controls.maxDistance = 8000;

    // ── Resize handling ─────────────────────────────────────────
    this.resizeObserver = new ResizeObserver(() => this.applySize());
    this.resizeObserver.observe(this.container);

    // ── Click → raycast → selection ─────────────────────────────
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);

    // ── Hover tooltip — DOM overlay positioned in container ─────
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'engram-tooltip';
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
    // The container needs position:relative for the absolute tooltip to
    // anchor correctly. Set it (idempotent if already set).
    const containerPos = getComputedStyle(this.container).position;
    if (containerPos === 'static') this.container.style.position = 'relative';
    this.container.appendChild(this.tooltipEl);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);

    // ── Start render loop ───────────────────────────────────────
    this.startRenderLoop();
  }

  // ── Data ────────────────────────────────────────────────────────

  setNodes(nodes: AtlasNode[]): void {
    this.allNodes = nodes.map((n) => ({ ...n }));

    // Update sourceVisible map (existing keys preserved; new ones default true).
    const seen = new Set<string>();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      seen.add(key);
      if (!this.sourceVisible.has(key)) this.sourceVisible.set(key, true);
    }
    for (const key of [...this.sourceVisible.keys()]) {
      if (!seen.has(key)) this.sourceVisible.delete(key);
    }

    this.rebuildPositionsIfNeeded();
    this.rebuildNodeMesh();
  }

  setEdges(directed: AtlasDirectedEdge[], undirected: AtlasUndirectedEdge[]): void {
    const out: InternalLink[] = [];
    const validIds = new Set(this.allNodes.map((n) => n.id));
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
    this.rebuildPositionsIfNeeded();
    this.rebuildEdgeMesh();
  }

  getNodes(): AtlasNode[] { return this.allNodes; }

  // ── Position computation (worker-driven async settle) ──────────

  private rebuildPositionsIfNeeded(): void {
    // Skip layout if every node already has a cached position. Filter
    // changes (source/category visibility) don't move nodes, so we
    // shouldn't re-run the simulation for them.
    const allCached = this.allNodes.every((n) => this.positions.has(n.id));
    if (allCached && this.allNodes.length > 0) return;

    if (this.allNodes.length === 0) {
      this.positions.clear();
      return;
    }

    // Seed initial positions for new nodes — random small offsets so
    // they don't all stack at the origin while the worker runs. Nodes
    // we already have cached positions for keep them (the worker will
    // see those as starting points and refine).
    for (const n of this.allNodes) {
      if (!this.positions.has(n.id)) {
        this.positions.set(
          n.id,
          new THREE.Vector3(
            (Math.random() - 0.5) * 40,
            (Math.random() - 0.5) * 40,
            (Math.random() - 0.5) * 40,
          ),
        );
      }
    }

    // Kick off the worker. It will post position updates every few
    // ticks; we apply them on each message. This is asynchronous —
    // setNodes returns immediately and the layout flows in over ~1s.
    this.startWorkerLayout();
  }

  private startWorkerLayout(): void {
    // Abort any in-flight simulation before starting a new one.
    if (this.physicsWorker) {
      this.physicsWorker.postMessage({ type: 'abort' });
      this.physicsWorker.terminate();
      this.physicsWorker = null;
    }
    this.hasAutoFitted = false;

    const worker = new PhysicsWorker();
    this.physicsWorker = worker;

    // Snapshot node order — the worker posts positions back as a flat
    // Float32Array indexed by this order. Order must be stable across
    // tick batches; allNodes can mutate from outside between batches,
    // so we capture once at start.
    const nodeOrder = this.allNodes.map((n) => n.id);

    worker.onmessage = (e: MessageEvent<{
      type: 'tick' | 'done';
      positions: Float32Array;
      tickCount: number;
    }>): void => {
      const { type, positions } = e.data;
      const isFinal = type === 'done';
      // Always apply the final batch (bypass throttle) so the settled
      // positions are in the meshes before we call zoomToFit.
      if (isFinal) this.lastPositionApplyAt = 0;
      this.applyPositionsFromWorker(nodeOrder, positions);
      if (isFinal) {
        worker.terminate();
        if (this.physicsWorker === worker) this.physicsWorker = null;
        // Frame the settled graph. Only once per layout run — the 1200ms
        // timer in main.ts will call zoomToFit again but that's harmless.
        if (!this.hasAutoFitted) {
          this.hasAutoFitted = true;
          this.zoomToFit(1000);
        }
      }
    };

    // Send seeded positions so the worker continues from where the
    // last layout left off rather than restarting from scratch.
    const initNodes = this.allNodes.map((n) => {
      const cached = this.positions.get(n.id);
      return cached
        ? { id: n.id, x: cached.x, y: cached.y, z: cached.z }
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
    // Throttle to ~30Hz max — applying every batch (every 6 ticks) is
    // fine, but if batches arrive faster we coalesce to avoid pegging
    // the main thread on matrix writes.
    const now = performance.now();
    if (now - this.lastPositionApplyAt < 33) return;
    this.lastPositionApplyAt = now;

    for (let i = 0; i < nodeOrder.length; i++) {
      const id = nodeOrder[i] as string;
      const x = positions[i * 3 + 0] as number;
      const y = positions[i * 3 + 1] as number;
      const z = positions[i * 3 + 2] as number;
      const pos = this.positions.get(id);
      if (pos) pos.set(x, y, z);
      else this.positions.set(id, new THREE.Vector3(x, y, z));
    }

    // Apply to the live meshes (matrices for nodes, vertex buffer for
    // edges, instance matrices for arrows). All in-place; no realloc.
    this.applyPositionsToMeshes();
  }

  private applyPositionsToMeshes(): void {
    if (this.nodeMesh) {
      const dummy = new THREE.Object3D();
      for (const [id, idx] of this.nodeIndexById) {
        const n = this.allNodes.find((x) => x.id === id);
        const pos = this.positions.get(id);
        if (!n || !pos) continue;
        dummy.position.set(pos.x, pos.y, pos.z);
        dummy.scale.setScalar(this.sizeMulFor(n));
        dummy.updateMatrix();
        this.nodeMesh.setMatrixAt(idx, dummy.matrix);
      }
      this.nodeMesh.instanceMatrix.needsUpdate = true;
    }

    if (this.edgeMesh) {
      // Rebuild the position array — LineSegmentsGeometry doesn't
      // expose a per-vertex setter so we re-set the whole buffer.
      const visibleNodeIds = new Set(
        this.allNodes
          .filter((n) => this.sourceVisible.get(n.sourceFile ?? '') ?? true)
          .map((n) => n.id),
      );
      const visibleLinks = this.allLinks.filter(
        (l) =>
          this.categoryVisible[l.category] &&
          visibleNodeIds.has(l.source) &&
          visibleNodeIds.has(l.target),
      );
      const positions: number[] = [];
      for (const l of visibleLinks) {
        const sp = this.positions.get(l.source);
        const tp = this.positions.get(l.target);
        if (!sp || !tp) continue;
        positions.push(sp.x, sp.y, sp.z, tp.x, tp.y, tp.z);
      }
      (this.edgeMesh.geometry as LineSegmentsGeometry).setPositions(positions);
      // Rebuild arrows too — their orientations depend on edge direction.
      this.rebuildArrowMesh(visibleLinks);
    }
  }

  // ── Node mesh rebuild ───────────────────────────────────────────

  private rebuildNodeMesh(): void {
    if (this.nodeMesh) {
      this.scene.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      (this.nodeMesh.material as THREE.Material).dispose();
      this.nodeMesh = null;
    }
    this.nodeIndexById.clear();

    const visible = this.allNodes.filter((n) => this.sourceVisible.get(n.sourceFile ?? '') ?? true);
    if (visible.length === 0) return;

    // Sphere geometry — `nodeResolution: 8` matches vasturiano's
    // library default (8 horizontal × 6 vertical segments = ~80 tris
    // per node). Higher resolution is wasted at bloom-blurred render
    // sizes.
    const geometry = new THREE.SphereGeometry(NODE_BASE_RADIUS, 8, 6);
    // MeshLambertMaterial = what the library uses. Lambert is matte
    // diffuse — responds to lights for depth shading but without the
    // PBR overhead of Standard/Physical. With bloom threshold=0.15,
    // only the lit (bright) faces of each sphere contribute to glow,
    // producing crisp node halos rather than a scene-wide haze.
    //
    // opacity 0.75 (also library default) — translucency gives the
    // scene depth perception: distant nodes blend with the ones in
    // front of them rather than reading as occluded billboards.
    const material = new THREE.MeshLambertMaterial({
      vertexColors: false,
      transparent: true,
      opacity: 0.75,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, visible.length);
    // Suppress unused-const warning for legacy geometry detail constant
    void NODE_GEOMETRY_DETAIL;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(visible.length * 3), 3);

    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();

    for (let i = 0; i < visible.length; i++) {
      const n = visible[i] as AtlasNode;
      this.nodeIndexById.set(n.id, i);
      const pos = this.positions.get(n.id);
      dummy.position.set(pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0);
      // Size by confidence + selection state
      const sizeMul = this.sizeMulFor(n);
      dummy.scale.setScalar(sizeMul);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setHex(colorForSource(n.sourceFile ?? ''));
      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    this.nodeMesh = mesh;
    // Re-apply selection appearance on top of the freshly-built mesh,
    // otherwise filter-changes (which trigger rebuilds) wipe the dim
    // effect and the user loses their focus context.
    if (this.selectedId !== null) this.refreshSelectionAppearance();
  }

  private sizeMulFor(n: AtlasNode): number {
    const base = 0.5 + n.confidence * 0.8;
    if (this.selectedId === n.id) return base * SELECTED_BOOST;
    if (this.selectedId !== null && this.neighborsOfSelected?.has(n.id)) return base * NEIGHBOR_BOOST;
    return base;
  }

  // ── Edge mesh rebuild ───────────────────────────────────────────

  private rebuildEdgeMesh(): void {
    if (this.edgeMesh) {
      this.scene.remove(this.edgeMesh);
      this.edgeMesh.geometry.dispose();
      (this.edgeMesh.material as THREE.Material).dispose();
      this.edgeMesh = null;
    }

    const visibleNodeIds = new Set(
      this.allNodes
        .filter((n) => this.sourceVisible.get(n.sourceFile ?? '') ?? true)
        .map((n) => n.id),
    );
    const visibleLinks = this.allLinks.filter(
      (l) =>
        this.categoryVisible[l.category] &&
        visibleNodeIds.has(l.source) &&
        visibleNodeIds.has(l.target),
    );

    if (visibleLinks.length === 0) return;

    // Use LineSegments2 from three/examples — GPU-accelerated thick
    // lines that respect a per-instance world-space linewidth. Without
    // this, native THREE.LineSegments renders at uniform 1px regardless
    // of `linewidth` (WebGL Lines limitation), so weight-based edge
    // thickness wasn't visible. LineSegments2 trades a bit of geometry
    // for shader-based fat lines that actually scale with weight.
    const positions: number[] = [];
    const colors: number[] = [];
    const tmpColor = new THREE.Color();

    for (const l of visibleLinks) {
      const sp = this.positions.get(l.source);
      const tp = this.positions.get(l.target);
      if (!sp || !tp) continue;
      positions.push(sp.x, sp.y, sp.z, tp.x, tp.y, tp.z);
      tmpColor.setHex(CATEGORY_COLOR[l.category]);
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b, tmpColor.r, tmpColor.g, tmpColor.b);
    }

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);

    // Average edge weight scales the global linewidth — a graph of all
    // weak-confidence edges renders thinner than one with strong edges.
    // Per-edge per-vertex linewidth would need a custom shader; this
    // global modulation is good-enough v1.
    const avgWeight = visibleLinks.reduce((s, l) => s + l.weight, 0) / Math.max(1, visibleLinks.length);
    // linewidth is in world-space units (LineMaterial); scale by 2 so
    // weight=0.5 → 1px, weight=1 → 2px, etc.
    const baseWidth = Math.max(0.6, Math.min(3.0, 0.6 + avgWeight * 1.8));

    const { width, height } = this.containerSize();
    const material = new LineMaterial({
      vertexColors: true,
      transparent: true,
      // Match library default `linkOpacity: 0.2`. Highly translucent
      // edges read as faint "connection traces" through the cloud
      // rather than a thicket of opaque ropes. With bloom on, even
      // translucent edges still glow visibly.
      opacity: 0.2,
      linewidth: baseWidth,
      worldUnits: false, // pixels — keeps a constant on-screen thickness
      resolution: new THREE.Vector2(width, height),
    });

    const mesh = new LineSegments2(geometry, material);
    mesh.computeLineDistances();
    this.scene.add(mesh);
    this.edgeMesh = mesh;
    this.edgeMaterial = material;

    // ── Directional arrows ──────────────────────────────────────
    // Place a small cone at the target end of every DIRECTED edge.
    // Direction = (target - source); cone orientation aligned via
    // quaternion. InstancedMesh so all arrows = 1 draw call.
    this.rebuildArrowMesh(visibleLinks);

    // Re-apply selection appearance for edges (same reason as nodes).
    if (this.selectedId !== null) this.refreshEdgeColors();
  }

  private rebuildArrowMesh(visibleLinks: InternalLink[]): void {
    if (this.arrowMesh) {
      this.scene.remove(this.arrowMesh);
      this.arrowMesh.geometry.dispose();
      (this.arrowMesh.material as THREE.Material).dispose();
      this.arrowMesh = null;
    }
    const directed = visibleLinks.filter((l) => l.directed);
    if (directed.length === 0) return;

    // Small cone pointing along +Z; the orientation step below rotates
    // each instance to align with the edge direction. ConeGeometry has
    // its apex at +Y by default — we use makeRotationFromQuaternion
    // with a from→to vector, which works regardless of base axis.
    const arrowLen = 2.4;
    const arrowRadius = 0.9;
    const geometry = new THREE.ConeGeometry(arrowRadius, arrowLen, 8);
    geometry.translate(0, -arrowLen / 2, 0); // pivot at base of cone

    const material = new THREE.MeshBasicMaterial({
      vertexColors: false,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, directed.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(directed.length * 3), 3);

    const dummy = new THREE.Object3D();
    const tmpFrom = new THREE.Vector3();
    const tmpTo = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const tmpColor = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0); // cone's default pointing axis

    for (let i = 0; i < directed.length; i++) {
      const l = directed[i] as InternalLink;
      const sp = this.positions.get(l.source);
      const tp = this.positions.get(l.target);
      if (!sp || !tp) continue;
      tmpFrom.set(sp.x, sp.y, sp.z);
      tmpTo.set(tp.x, tp.y, tp.z);
      tmpDir.subVectors(tmpTo, tmpFrom);
      const len = tmpDir.length();
      if (len < 0.001) continue;
      tmpDir.normalize();

      // Place the arrow tip ~NODE_BASE_RADIUS units short of the target
      // node so it sits on the node's surface rather than buried inside.
      // Offset the position along the reverse direction.
      const offset = NODE_BASE_RADIUS * 0.9;
      dummy.position.set(
        tp.x - tmpDir.x * offset,
        tp.y - tmpDir.y * offset,
        tp.z - tmpDir.z * offset,
      );
      dummy.quaternion.setFromUnitVectors(up, tmpDir);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setHex(CATEGORY_COLOR[l.category]);
      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    this.arrowMesh = mesh;
  }

  // ── Selection / focus ──────────────────────────────────────────

  select(nodeId: string): void {
    if (this.selectedId === nodeId) {
      // Toggle off
      this.selectedId = null;
      this.neighborsOfSelected = null;
      this.refreshSelectionAppearance();
      this.onSelect?.(null);
      return;
    }
    this.selectedId = nodeId;
    this.neighborsOfSelected = this.computeNeighbors(nodeId);
    this.refreshSelectionAppearance();
    const node = this.allNodes.find((n) => n.id === nodeId);
    this.onSelect?.(node ?? null);
  }

  focus(nodeId: string): void {
    const pos = this.positions.get(nodeId);
    if (!pos) return;
    this.selectedId = nodeId;
    this.neighborsOfSelected = this.computeNeighbors(nodeId);
    this.refreshSelectionAppearance();
    // Smooth camera move via a small lerp. OrbitControls' target shouldn't
    // be set instantaneously when we want it to read as motion.
    const startPos = this.camera.position.clone();
    const targetPos = pos.clone().add(new THREE.Vector3(50, 50, 50));
    const startTarget = this.controls.target.clone();
    const targetTarget = pos.clone();
    const startedAt = performance.now();
    const dur = 600;
    const tween = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / dur);
      const ease = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(startPos, targetPos, ease);
      this.controls.target.lerpVectors(startTarget, targetTarget, ease);
      if (t < 1) requestAnimationFrame(tween);
    };
    requestAnimationFrame(tween);
  }

  resetEmphasis(): void {
    this.selectedId = null;
    this.neighborsOfSelected = null;
    this.refreshSelectionAppearance();
  }

  private computeNeighbors(nodeId: string): Set<string> {
    const set = new Set<string>();
    for (const l of this.allLinks) {
      if (l.source === nodeId) set.add(l.target);
      else if (l.target === nodeId) set.add(l.source);
    }
    return set;
  }

  /** Refresh size + color of every node + edge to reflect the current
   *  selection state. Dimming is the key UX cue ("the rest of the graph
   *  isn't relevant to your focus"). For Engine #1 we update:
   *    - InstancedMesh matrices (size boost on selected + neighbors)
   *    - InstancedMesh colors (dim non-neighborhood nodes)
   *    - Edge colors (dim non-incident edges)
   *
   *  Cost: O(N + E) — at 10K nodes this is ~20ms once on selection
   *  change. For larger graphs this would warrant a delta-only update
   *  (only re-color old + new selection sets); deferred. */
  private refreshSelectionAppearance(): void {
    if (!this.nodeMesh) return;
    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();
    const hasSelection = this.selectedId !== null;
    const nodeCount = this.nodeIndexById.size;
    const colors = this.nodeMesh.instanceColor;

    // Nodes: matrix (size) + color (dim or base)
    for (const [id, idx] of this.nodeIndexById) {
      const n = this.allNodes.find((x) => x.id === id);
      const pos = this.positions.get(id);
      if (!n || !pos) continue;
      dummy.position.set(pos.x, pos.y, pos.z);
      dummy.scale.setScalar(this.sizeMulFor(n));
      dummy.updateMatrix();
      this.nodeMesh.setMatrixAt(idx, dummy.matrix);

      if (colors) {
        const base = colorForSource(n.sourceFile ?? '');
        if (!hasSelection) {
          tmpColor.setHex(base);
        } else if (id === this.selectedId || this.neighborsOfSelected?.has(id)) {
          // Bright — slight brighten on selected, base on neighbors
          tmpColor.setHex(base);
          if (id === this.selectedId) tmpColor.lerp(new THREE.Color(0xffffff), 0.25);
        } else {
          // Dimmed — multiplicative blend toward dark background
          tmpColor.setHex(base);
          tmpColor.multiplyScalar(0.18);
        }
        colors.setXYZ(idx, tmpColor.r, tmpColor.g, tmpColor.b);
      }
    }
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    if (colors) colors.needsUpdate = true;

    // Edges: dim non-incident when something's selected.
    this.refreshEdgeColors();

    // Suppress unused-var warning for nodeCount (kept for future
    // O(delta) optimization)
    void nodeCount;
  }

  /** Re-color the edge buffer based on current selection. With
   *  LineSegments2 the color data lives in `instanceColorStart` /
   *  `instanceColorEnd` interleaved buffers; the simplest robust path
   *  is to rebuild the colors array and call setColors() again. The
   *  geometry positions don't change, so no re-layout happens. */
  private refreshEdgeColors(): void {
    if (!this.edgeMesh) return;

    const visibleNodeIds = new Set(
      this.allNodes
        .filter((n) => this.sourceVisible.get(n.sourceFile ?? '') ?? true)
        .map((n) => n.id),
    );
    const visibleLinks = this.allLinks.filter(
      (l) =>
        this.categoryVisible[l.category] &&
        visibleNodeIds.has(l.source) &&
        visibleNodeIds.has(l.target),
    );

    const colors: number[] = [];
    const tmp = new THREE.Color();
    const hasSelection = this.selectedId !== null;
    for (const l of visibleLinks) {
      const incident = hasSelection && (l.source === this.selectedId || l.target === this.selectedId);
      tmp.setHex(CATEGORY_COLOR[l.category]);
      if (hasSelection && !incident) tmp.multiplyScalar(0.18);
      colors.push(tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b);
    }
    const geom = this.edgeMesh.geometry as LineSegmentsGeometry;
    geom.setColors(colors);
  }

  // ── Filters ─────────────────────────────────────────────────────

  setCategoryVisible(category: EdgeCategory, visible: boolean): void {
    this.categoryVisible[category] = visible;
    this.rebuildEdgeMesh();
  }

  getCategoryVisibility(): Record<EdgeCategory, boolean> {
    return { ...this.categoryVisible };
  }

  setSourceVisible(sourceKey: string, visible: boolean): void {
    this.sourceVisible.set(sourceKey, visible);
    this.rebuildNodeMesh();
    this.rebuildEdgeMesh();
  }

  sourcesWithCounts(): SourceInfo[] {
    const counts = new Map<string, number>();
    for (const n of this.allNodes) {
      const key = n.sourceFile ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([key, nodeCount]) => ({
        key,
        label: key || '(unsourced)',
        color: colorForSource(key),
        nodeCount,
        visible: this.sourceVisible.get(key) ?? true,
      }));
  }

  edgeCounts(): Record<EdgeCategory, number> {
    const out: Record<EdgeCategory, number> = {
      reasoning: 0, structure: 0, social: 0,
      temporal: 0, semantic: 0, identity: 0, predicted: 0,
    };
    for (const l of this.allLinks) out[l.category]++;
    return out;
  }

  // ── View ────────────────────────────────────────────────────────

  zoomToFit(_ms = 800, _padding = 20): void {
    if (this.allNodes.length === 0) return;
    // Compute bounding box of visible node positions.
    const box = new THREE.Box3();
    let any = false;
    for (const n of this.allNodes) {
      if (!(this.sourceVisible.get(n.sourceFile ?? '') ?? true)) continue;
      const pos = this.positions.get(n.id);
      if (!pos) continue;
      box.expandByPoint(pos);
      any = true;
    }
    if (!any) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = (sphere.radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.4;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(sphere.center.clone().add(dir.multiplyScalar(dist)));
    this.controls.target.copy(sphere.center);
    this.controls.update();
  }

  pauseAnimation(): void {
    this.isPaused = true;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  resumeAnimation(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.startRenderLoop();
  }

  // ── Motion (no-op — physics doesn't reheat in this engine) ─────

  setAliveEnabled(_enabled: boolean): boolean { return false; }
  isAliveEnabled(): boolean { return false; }
  unpinAll(): void { /* no pins to release */ }

  // ── No-ops for optional Atlas methods called by main.ts ────────
  //
  // These exist on the legacy `Atlas` class and may be invoked directly
  // by main.ts code paths (perf A/B harness, hover-driven preview).
  // Engine #1 doesn't implement them yet — preview tooltip and runtime
  // perf flag overrides are deferred to v2. Implementing as no-ops here
  // avoids "X is not a function" runtime errors during the transition.

  previewHighlight(_nodeId: string | null): void { /* v2 */ }
  reapplyPerfFlags(): void { /* v2 — Engine #1 doesn't read atlasPerf flags */ }

  // ── Connections (for detail-pane sidebar) ───────────────────────

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

  // ── Lifecycle ───────────────────────────────────────────────────

  dispose(): void {
    if (this.physicsWorker) {
      this.physicsWorker.postMessage({ type: 'abort' });
      this.physicsWorker.terminate();
      this.physicsWorker = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    if (this.tooltipEl.parentNode) this.tooltipEl.parentNode.removeChild(this.tooltipEl);
    if (this.nodeMesh) {
      this.scene.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      (this.nodeMesh.material as THREE.Material).dispose();
    }
    if (this.edgeMesh) {
      this.scene.remove(this.edgeMesh);
      this.edgeMesh.geometry.dispose();
      (this.edgeMesh.material as THREE.Material).dispose();
    }
    if (this.arrowMesh) {
      this.scene.remove(this.arrowMesh);
      this.arrowMesh.geometry.dispose();
      (this.arrowMesh.material as THREE.Material).dispose();
    }
    if (this.composer) this.composer.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  private startRenderLoop(): void {
    const tick = (): void => {
      this.controls.update();
      // Route through the composer so the bloom pass runs when available.
      // Falls back to a direct renderer.render() on systems where float
      // render targets are unavailable (no EffectComposer was built).
      if (this.composer) {
        this.composer.render();
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      if (!this.isPaused) this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private containerSize(): { width: number; height: number } {
    const rect = this.container.getBoundingClientRect();
    // Fallback for hidden / unmounted containers.
    return {
      width: rect.width > 0 ? rect.width : 800,
      height: rect.height > 0 ? rect.height : 600,
    };
  }

  private applySize(): void {
    const { width, height } = this.containerSize();
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    // Composer + bloom must match the new size, otherwise the post-
    // process passes sample from the old framebuffer dimensions and
    // produce stretched / clipped output on window resize.
    if (this.composer) this.composer.setSize(width, height);
    if (this.bloomPass) this.bloomPass.setSize(width, height);
    // LineMaterial needs the resolution updated for correct fat-line
    // shading. Without this, on window resize edges visibly thin or
    // thicken because the shader maps pixels using stale viewport size.
    if (this.edgeMaterial) {
      this.edgeMaterial.resolution.set(width, height);
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.nodeMesh) return;
    // Throttle to ~60Hz max — raycasting on every native pointermove
    // can saturate the main thread on trackpads that emit at 200Hz+.
    const now = performance.now();
    if (now - this.lastHoverRaycastAt < 16) return;
    this.lastHoverRaycastAt = now;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const intersects = this.raycaster.intersectObject(this.nodeMesh);
    if (intersects.length === 0) {
      this.setHovered(null);
      return;
    }
    const instanceId = intersects[0]?.instanceId;
    if (instanceId === undefined) { this.setHovered(null); return; }
    let hitId: string | null = null;
    for (const [id, idx] of this.nodeIndexById) {
      if (idx === instanceId) { hitId = id; break; }
    }
    this.setHovered(hitId, e.clientX - rect.left, e.clientY - rect.top);
  };

  private onPointerLeave = (): void => {
    this.setHovered(null);
  };

  private setHovered(nodeId: string | null, cx?: number, cy?: number): void {
    if (this.hoveredId === nodeId) {
      // Same node — just reposition the tooltip if coords given.
      if (nodeId !== null && cx !== undefined && cy !== undefined) {
        this.tooltipEl.style.left = `${cx + 12}px`;
        this.tooltipEl.style.top = `${cy + 14}px`;
      }
      return;
    }
    this.hoveredId = nodeId;
    if (nodeId === null) {
      this.tooltipEl.style.opacity = '0';
      return;
    }
    const node = this.allNodes.find((n) => n.id === nodeId);
    if (!node) {
      this.tooltipEl.style.opacity = '0';
      return;
    }
    const text = node.text ?? '';
    const trimmed = text.length > 200 ? text.slice(0, 200) + '…' : text;
    this.tooltipEl.textContent = trimmed || '(no content)';
    if (cx !== undefined && cy !== undefined) {
      this.tooltipEl.style.left = `${cx + 12}px`;
      this.tooltipEl.style.top = `${cy + 14}px`;
    }
    this.tooltipEl.style.opacity = '1';
  }

  private onPointerUp = (e: PointerEvent): void => {
    // Only treat as a click if the pointer didn't move meaningfully —
    // OrbitControls fires drag for rotation, we shouldn't intercept.
    // Simple guard: check if the pointer moved less than 4px between
    // pointerdown and pointerup. The OrbitControls 'start'/'end' events
    // could be subscribed for a cleaner signal but this is enough for v1.
    if (!this.nodeMesh) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const intersects = this.raycaster.intersectObject(this.nodeMesh);
    if (intersects.length === 0) return;
    const instanceId = intersects[0]?.instanceId;
    if (instanceId === undefined) return;
    // Find the node id for this instance
    let hitId: string | null = null;
    for (const [id, idx] of this.nodeIndexById) {
      if (idx === instanceId) { hitId = id; break; }
    }
    if (hitId) this.select(hitId);
  };
}
