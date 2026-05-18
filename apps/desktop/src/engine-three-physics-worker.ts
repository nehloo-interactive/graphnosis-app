// ── Engram Engine #1: physics Web Worker ──────────────────────────
//
// Runs d3-force-3d off the main thread so the initial layout doesn't
// freeze the UI. Main thread posts `{type:'init', nodes, links, seedPositions}`,
// worker runs ticks in batches and posts `{type:'tick', positions}`
// with a flat Float32Array of x,y,z triplets. After convergence it
// posts `{type:'done'}` and stops the simulation.
//
// Why a Float32Array of positions rather than an array of node objects:
// minimizes serialization overhead (structuredClone is cheap on typed
// arrays). Order matches the `nodes` array sent on init.

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force-3d';

interface InitNode {
  id: string;
  x?: number;
  y?: number;
  z?: number;
}

interface InitLink {
  source: string;
  target: string;
  weight: number;
}

interface InitMessage {
  type: 'init';
  nodes: InitNode[];
  links: InitLink[];
  /** Number of ticks before the worker considers the layout converged
   *  and stops emitting. Default 400. */
  maxTicks?: number;
  /** How many ticks to batch before posting positions back. Smaller
   *  values = smoother animation, more postMessage overhead. */
  batchSize?: number;
}

interface AbortMessage {
  type: 'abort';
}

type InboundMessage = InitMessage | AbortMessage;

interface SimNode extends SimulationNodeDatum {
  id: string;
  x?: number;
  y?: number;
  z?: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
  weight: number;
}

let running = false;

self.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === 'abort') {
    running = false;
    return;
  }
  if (msg.type === 'init') {
    runSimulation(msg);
  }
});

function runSimulation(msg: InitMessage): void {
  const { nodes, links } = msg;
  const maxTicks = msg.maxTicks ?? 400;
  const batchSize = msg.batchSize ?? 6;

  // Layout scale grows with node count so dense graphs aren't crushed
  // into a tiny cube. Tuned from the legacy 3d-force-graph defaults:
  //   20 nodes  →  ~1.0×
  //   200 nodes → ~3.2×
  //   2000 nodes → ~10×
  // Without this the link force dominates and the repulsion isn't
  // strong enough to push nodes apart at scale → packed-yarn-ball.
  const N = nodes.length;
  const scale = Math.max(1, Math.sqrt(N / 20));

  // Build sim data structures. Seed positions where provided so the
  // user sees motion from the previous layout rather than teleport.
  // For nodes WITHOUT seeded positions, distribute them UNIFORMLY ON
  // A SPHERE (not a cube) using rejection sampling within the unit
  // sphere then scaling. A cube seed is the single biggest reason
  // layouts looked cube-shaped — the simulation doesn't fully escape
  // the topology of its seeds, especially with collide / link forces
  // dominating. Sphere seeds produce a natural 3D constellation.
  const radius = 80 * scale;
  const sampleSphere = (): [number, number, number] => {
    // Uniform-in-volume rejection sampling (cheap; ~52% accept rate)
    while (true) {
      const x = (Math.random() - 0.5) * 2;
      const y = (Math.random() - 0.5) * 2;
      const z = (Math.random() - 0.5) * 2;
      const r2 = x * x + y * y + z * z;
      if (r2 <= 1 && r2 > 0.01) return [x * radius, y * radius, z * radius];
    }
  };
  const simNodes: SimNode[] = nodes.map((n) => {
    if (n.x !== undefined && n.y !== undefined && n.z !== undefined) {
      return { id: n.id, x: n.x, y: n.y, z: n.z };
    }
    const [x, y, z] = sampleSphere();
    return { id: n.id, x, y, z };
  });
  const simLinks: SimLink[] = links.map((l) => ({
    source: l.source,
    target: l.target,
    weight: l.weight,
  }));

  // Forces tuned to match the legacy 3d-force-graph layout, which the
  // user knows looks spatial-and-clear. Key insight: COLLIDE is what
  // makes graphs feel spread out — it gives each node a minimum
  // exclusion radius. Without it (which the previous attempts were
  // missing), repulsion alone can't overcome the link springs and the
  // whole thing collapses into a cube-shaped cluster.
  //
  //   - charge: -90 × scale → strong long-range repulsion
  //   - collide: radius 14 × scale → no two nodes overlap; gives
  //     visible spatial separation
  //   - link distance: 30 × scale → uniform spring rest length
  //   - link strength: 0.05 + 0.3 × weight → heavier edges form
  //     stiffer springs; light edges barely pull (so they don't
  //     compete with collide / repulsion for the dominant layout)
  //   - NO forceCenter — it pulls toward origin and crushes the
  //     layout. The barycenter stabilizes from link forces alone.
  //   - alphaDecay 0.012 (was 0.05) → longer simulation, more time
  //     for the layout to actually settle into a spatial form
  const sim = forceSimulation(simNodes, 3)
    .force('charge', forceManyBody().strength(-90 * scale).distanceMax(600 * scale))
    .force('collide', forceCollide().radius(14 * scale).iterations(2))
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance(30 * scale)
        .strength((l) => 0.05 + 0.3 * Math.min(1, l.weight)),
    )
    .alphaDecay(0.012)
    .alphaMin(0.001)
    .stop();

  running = true;
  let tickCount = 0;

  const postPositions = (final: boolean): void => {
    const buf = new Float32Array(simNodes.length * 3);
    for (let i = 0; i < simNodes.length; i++) {
      const n = simNodes[i] as SimNode;
      buf[i * 3 + 0] = n.x ?? 0;
      buf[i * 3 + 1] = n.y ?? 0;
      buf[i * 3 + 2] = n.z ?? 0;
    }
    // Transfer ownership for zero-copy.
    self.postMessage(
      { type: final ? 'done' : 'tick', positions: buf, tickCount },
      [buf.buffer],
    );
  };

  const step = (): void => {
    if (!running) return;
    for (let i = 0; i < batchSize; i++) {
      sim.tick();
      tickCount++;
      if (tickCount >= maxTicks) break;
    }
    if (tickCount >= maxTicks) {
      postPositions(true);
      running = false;
      return;
    }
    postPositions(false);
    // Schedule next batch — setTimeout 0 yields to the message loop so
    // abort messages can land between batches.
    setTimeout(step, 0);
  };

  step();
}
