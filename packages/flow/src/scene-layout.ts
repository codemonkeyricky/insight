// The generic scene engine: lays a Scene out whole (bottom-up, one ELK graph per container), then answers what is
// drawn for an open set: frames, boxes and the edges between the visible boxes. See scene.ts for the model.
import { PROJECT_ID, type Rect, type ScopeLink, type ScopeTree } from "./scope-map.js";
import { LAYERED, ZOOM_SIZE, edgeCurve, frameSize, readLayout, type ContainerLayout, type LayoutGraph, type Placed, type PlacedEdge, type PlacedItem, type Size } from "./zoom-layout.js";
import { CHART_HEAD, CHART_PAD, type Scene, type SceneEdge, SceneEdgeKind, SceneLayout, SceneNode } from "./scene.js";

/** What a solver answers for one container graph: ELK's shape, reduced to what readLayout reads. */
export interface SolvedGraph {
  width?: number;
  height?: number;
  children?: { id: string; x?: number; y?: number }[];
}
export type SceneSolver = (graph: LayoutGraph) => Promise<SolvedGraph>;

/** An edge drawn between two visible boxes, summed over the scene edges that climb to them. */
export interface SceneMapEdge {
  from: string;
  to: string;
  kind: SceneEdgeKind;
  count: number;
  candidate: boolean;
  /** For a sync edge, what the threads share: "lock" or "channel". Sync edges of different hows are kept apart. */
  how?: string;
}

/**
 * The box size of a node with no children: its level's box, or a function box when the scene has no such level. A node
 * with a chart is at least large enough to hold it, under a header for its name.
 */
export function sceneLeafSize(scene: Scene, id: string): Size {
  const node = scene.nodes.get(id);
  const box = (node === undefined ? undefined : scene.levels[node.kind]?.box) ?? ZOOM_SIZE.fn;
  const chart = node?.chart;
  if (chart === undefined) return box;
  return { w: Math.max(box.w, chart.w + 2 * CHART_PAD), h: Math.max(box.h, CHART_HEAD + chart.h + 2 * CHART_PAD) };
}

/** The ELK options the container `id` lays its children out with: its level's layout, else LAYERED. */
export function sceneLayoutOptions(scene: Scene, id: string): Record<string, string> {
  const node = scene.nodes.get(id);
  const own = (node === undefined ? undefined : scene.levels[node.kind]?.layout) ?? LAYERED;
  if ((node?.children.length ?? 0) > LAYERED_MAX_CHILDREN && own["elk.algorithm"] === "layered") return COLUMNS;
  return own;
}

/**
 * The most children a container lays out with the layered algorithm. Its time grows much faster than linearly: 260
 * functions with 300 calls take about 0.4 s, 600 with 1200 calls about 7 s, and 1500 about 25 s. Past this many
 * children a container is laid out in call columns instead (callColumns), which takes milliseconds and never goes to
 * ELK, so a big container costs the same whatever its edges.
 */
export const LAYERED_MAX_CHILDREN = 150;

/** The options a container past LAYERED_MAX_CHILDREN is laid out with: call columns, see callColumns. Never sent to ELK. */
export const COLUMNS: Record<string, string> = {
  "elk.algorithm": "insight.columns",
  "elk.spacing.nodeNode": "24",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

/** The options a rectpacking container lays out with (no level uses it by default): rectangles packed in rows. */
export const PACKED: Record<string, string> = {
  "elk.algorithm": "rectpacking",
  "elk.spacing.nodeNode": "24",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

/** Depth of a node: the root is 0. Unknown ids are -1. */
export function sceneDepth(scene: Scene, id: string): number {
  let depth = -1;
  for (let cur = scene.nodes.get(id); cur; cur = cur.parent === undefined ? undefined : scene.nodes.get(cur.parent)) depth += 1;
  return depth;
}

/** Root first, down to `id`. Empty for an unknown id. */
export function sceneBreadcrumb(scene: Scene, id: string): SceneNode[] {
  const out: SceneNode[] = [];
  for (let cur = scene.nodes.get(id); cur; cur = cur.parent === undefined ? undefined : scene.nodes.get(cur.parent)) out.unshift(cur);
  return out;
}

/** Nodes that must be open for `focus` to show: every ancestor except the root, and the focus itself when it has children. */
export function sceneOpenFor(scene: Scene, focus: string): Set<string> {
  const open = new Set<string>();
  const node = scene.nodes.get(focus);
  if (!node) return open;
  if (node.children.length > 0) open.add(focus);
  for (let p = node.parent; p !== undefined; p = scene.nodes.get(p)?.parent) {
    if (p !== scene.root) open.add(p);
  }
  return open;
}

/** The boxes on screen for an open set: the root's children, recursively through open nodes with children. */
export function sceneFrontier(scene: Scene, open: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    const n = scene.nodes.get(id);
    if (!n) return;
    if (id === scene.root || (open.has(id) && n.children.length > 0)) {
      for (const c of n.children) visit(c);
    } else {
      out.push(id);
    }
  };
  visit(scene.root);
  return out;
}

/** The visible box that stands for `id`: itself, else its deepest visible ancestor. Undefined when none is visible. */
export function sceneBoxOf(scene: Scene, visible: ReadonlySet<string>, id: string): string | undefined {
  let cur = scene.nodes.get(id);
  if (!cur) return undefined;
  if (visible.has(id)) return id;
  while (cur?.parent !== undefined) {
    if (visible.has(cur.parent)) return cur.parent;
    cur = scene.nodes.get(cur.parent);
  }
  return undefined;
}

/** The scene edges drawn for an open set, climbed to visible boxes and summed per (from, to, kind). Self-edges dropped. */
export function sceneEdges(scene: Scene, open: ReadonlySet<string>): SceneMapEdge[] {
  const visible = new Set(sceneFrontier(scene, open));
  const acc = new Map<string, SceneMapEdge>();
  for (const e of scene.edges) {
    const a = sceneBoxOf(scene, visible, e.from);
    const b = sceneBoxOf(scene, visible, e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const how = e.kind === "sync" ? e.how : undefined;
    const key = `${a}\u0000${b}\u0000${e.kind}\u0000${how ?? ""}`;
    let m = acc.get(key);
    if (!m) {
      m = { from: a, to: b, kind: e.kind, count: 0, candidate: false, ...(how !== undefined ? { how } : {}) };
      acc.set(key, m);
    }
    m.count += e.count;
    m.candidate ||= e.candidate === true;
  }
  return [...acc.values()];
}

/** The size a node takes in its parent: its level's box for a leaf, else the frame around its laid-out children. */
export function sceneNodeSize(scene: Scene, id: string, layout: SceneLayout): Size {
  const n = scene.nodes.get(id);
  const own = n !== undefined && n.children.length > 0 ? layout.containers[id] : undefined;
  return own ? frameSize({ w: own.w, h: own.h }) : sceneLeafSize(scene, id);
}

/**
 * Where a scene edge lands in the layout: the one container whose graph joins two different children by it (the
 * deepest common ancestor of its ends), and those two children. Undefined when the ends share no ancestor, when an
 * end is unknown, or when one end lies under the other (both would climb to the same child).
 */
export function sceneEdgeContainer(scene: Scene, edge: Pick<SceneEdge, "from" | "to">): { container: string; a: string; b: string } | undefined {
  if (!scene.nodes.has(edge.from) || !scene.nodes.has(edge.to)) return undefined;
  const chain: string[] = [];
  const at = new Map<string, number>();
  for (let cur: string | undefined = edge.from; cur !== undefined && !at.has(cur); cur = scene.nodes.get(cur)?.parent) {
    at.set(cur, chain.length);
    chain.push(cur);
  }
  const seen = new Set<string>();
  let prev: string | undefined;
  for (let cur: string | undefined = edge.to; cur !== undefined && !seen.has(cur); cur = scene.nodes.get(cur)?.parent) {
    seen.add(cur);
    const i = at.get(cur);
    if (i !== undefined) {
      const a = i > 0 ? chain[i - 1] : undefined;
      if (a === undefined || prev === undefined) return undefined;
      return { container: cur, a, b: prev };
    }
    prev = cur;
  }
  return undefined;
}

/** The container graph from the edges already known to land in it (in scene order). */
function graphOf(scene: Scene, container: string, sizes: ReadonlyMap<string, Size>, landed: readonly { a: string; b: string }[]): LayoutGraph {
  const kids = scene.nodes.get(container)?.children ?? [];
  const children = kids.map((id) => {
    const s = sizes.get(id) ?? sceneLeafSize(scene, id);
    return { id, width: s.w, height: s.h };
  });
  const seen = new Set<string>();
  const edges: LayoutGraph["edges"] = [];
  for (const { a, b } of landed) {
    const key = `${a}\u0000${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `e${edges.length}`, sources: [a], targets: [b] });
  }
  return { id: container, layoutOptions: sceneLayoutOptions(scene, container), children, edges };
}

/** The ELK graph of one container. `sizes` gives each child's size; edges join children that scene edges climb to. */
export function sceneLayoutGraph(scene: Scene, container: string, sizes: ReadonlyMap<string, Size>): LayoutGraph {
  const landed: { a: string; b: string }[] = [];
  for (const e of scene.edges) {
    const at = sceneEdgeContainer(scene, e);
    if (at !== undefined && at.container === container) landed.push(at);
  }
  return graphOf(scene, container, sizes, landed);
}

/** Every node with children, children before their parent (post-order over the children's order), root last. */
export function sceneContainers(scene: Scene): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = scene.nodes.get(id);
    if (!n || n.children.length === 0) return;
    for (const c of n.children) visit(c);
    out.push(id);
  };
  visit(scene.root);
  return out;
}

/**
 * Packs a container's children in rows, in their order: left to right, wrapping at a width that makes the block
 * roughly 1.5 times wider than tall. Edges are ignored. This stands in for ELK's rectpacking, which does not return
 * for some mixes of box sizes (a group of 43 function boxes with charts, tall and short, ran for 20 minutes), and a
 * layout that never finishes freezes the browser tab and the demo capture alike.
 */
export function packRows(graph: LayoutGraph): SolvedGraph {
  const gap = Number(graph.layoutOptions["elk.spacing.nodeNode"] ?? 24);
  const gapOf = Number.isFinite(gap) ? gap : 24;
  const area = graph.children.reduce((sum, c) => sum + (c.width + gapOf) * (c.height + gapOf), 0);
  const widest = graph.children.reduce((max, c) => Math.max(max, c.width), 0);
  const rowWidth = Math.max(widest, Math.sqrt(area * 1.5));
  const placed: { id: string; x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const c of graph.children) {
    if (x > 0 && x + c.width > rowWidth) {
      x = 0;
      y += rowHeight + gapOf;
      rowHeight = 0;
    }
    placed.push({ id: c.id, x, y });
    x += c.width + gapOf;
    rowHeight = Math.max(rowHeight, c.height);
    width = Math.max(width, x - gapOf);
  }
  return { width, height: placed.length === 0 ? 0 : y + rowHeight, children: placed };
}

/**
 * Lays a container out in call columns, flowing left to right as LAYERED does. A child's column is its BFS distance
 * from the sources: the children nothing in the container calls, in child order. Children no source reaches start
 * a new BFS, from the first unreached child, at column 0. Within a column, children are ordered by the mean position
 * of their callers in earlier columns (ties by child order). A column taller than H wraps into side-by-side
 * sub-columns, where H = max(tallest child, sqrt(totalArea / 1.5)). Linear in children plus edges; no randomness.
 * Edges to unknown ids and self-edges are ignored. Returns the same shape as packRows.
 */
export function callColumns(graph: LayoutGraph): SolvedGraph {
  const n = graph.children.length;
  const gap = Number(graph.layoutOptions["elk.spacing.nodeNode"] ?? 24);
  const gapOf = Number.isFinite(gap) ? gap : 24;
  const index = new Map(graph.children.map((c, i) => [c.id, i] as const));
  const out: number[][] = graph.children.map(() => []);
  const into: number[][] = graph.children.map(() => []);
  for (const e of graph.edges) {
    for (const s of e.sources) {
      for (const t of e.targets) {
        const a = index.get(s);
        const b = index.get(t);
        if (a === undefined || b === undefined || a === b) continue;
        out[a]?.push(b);
        into[b]?.push(a);
      }
    }
  }

  // Column of each child: BFS distance from the sources, then from each child nothing above reached.
  const depth = new Array<number>(n).fill(-1);
  const bfs = (starts: readonly number[]): void => {
    const queue: number[] = [];
    for (const s of starts) {
      depth[s] = 0;
      queue.push(s);
    }
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q] as number;
      for (const next of out[cur] ?? []) {
        if (depth[next] !== -1) continue;
        depth[next] = (depth[cur] ?? 0) + 1;
        queue.push(next);
      }
    }
  };
  bfs(graph.children.map((_, i) => i).filter((i) => (into[i]?.length ?? 0) === 0));
  for (let i = 0; i < n; i++) if (depth[i] === -1) bfs([i]);

  const columns: number[][] = [];
  for (let i = 0; i < n; i++) {
    const d = depth[i] ?? 0;
    while (columns.length <= d) columns.push([]);
    columns[d]?.push(i);
  }

  // Order each column by the barycenter of its callers in earlier columns. A child with none goes last, by child order.
  const pos = new Array<number>(n).fill(0);
  for (let k = 0; k < columns.length; k++) {
    const col = columns[k] ?? [];
    const bary = new Map<number, number>();
    for (const i of col) {
      let sum = 0;
      let count = 0;
      for (const p of into[i] ?? []) {
        if ((depth[p] ?? 0) < k) {
          sum += pos[p] ?? 0;
          count += 1;
        }
      }
      bary.set(i, count > 0 ? sum / count : Number.POSITIVE_INFINITY);
    }
    col.sort((a, b) => {
      const ba = bary.get(a) ?? 0;
      const bb = bary.get(b) ?? 0;
      if (ba !== bb) return ba < bb ? -1 : 1;
      return a - b;
    });
    col.forEach((i, p) => {
      pos[i] = p;
    });
  }

  // Stack each column, wrapping it into sub-columns past H, and lay the columns out side by side.
  const area = graph.children.reduce((sum, c) => sum + (c.width + gapOf) * (c.height + gapOf), 0);
  const tallest = graph.children.reduce((max, c) => Math.max(max, c.height), 0);
  const limit = Math.max(tallest, Math.sqrt(area / 1.5));
  const placed: { id: string; x: number; y: number }[] = [];
  let x = 0;
  let width = 0;
  let height = 0;
  for (const col of columns) {
    const subs: { items: { i: number; y: number }[]; w: number; h: number }[] = [];
    let cur: { items: { i: number; y: number }[]; w: number; h: number } = { items: [], w: 0, h: 0 };
    for (const i of col) {
      const c = graph.children[i];
      if (c === undefined) continue;
      let y = cur.items.length === 0 ? 0 : cur.h + gapOf;
      if (cur.items.length > 0 && y + c.height > limit) {
        subs.push(cur);
        cur = { items: [], w: 0, h: 0 };
        y = 0;
      }
      cur.items.push({ i, y });
      cur.w = Math.max(cur.w, c.width);
      cur.h = y + c.height;
    }
    if (cur.items.length > 0) subs.push(cur);
    let sx = x;
    let colHeight = 0;
    for (const sub of subs) {
      for (const it of sub.items) placed.push({ id: graph.children[it.i]?.id ?? "", x: sx, y: it.y });
      sx += sub.w + gapOf;
      colHeight = Math.max(colHeight, sub.h);
    }
    if (subs.length > 0) {
      width = Math.max(width, sx - gapOf);
      height = Math.max(height, colHeight);
      x = sx;
    }
  }
  return { width, height, children: placed };
}

/** Lays the whole scene out, deepest containers first. Deterministic for a deterministic solver. */
export async function layoutScene(scene: Scene, solve: SceneSolver): Promise<SceneLayout> {
  // Each edge joins two children of exactly one container, so the edges are sorted out once, not once per container.
  const landed = new Map<string, { a: string; b: string }[]>();
  for (const e of scene.edges) {
    const at = sceneEdgeContainer(scene, e);
    if (at === undefined) continue;
    const list = landed.get(at.container);
    if (list) list.push(at);
    else landed.set(at.container, [at]);
  }
  const containers: Record<string, ContainerLayout> = {};
  // Solved one at a time, in a fixed order, so the answer does not depend on which solve finishes first.
  for (const id of sceneContainers(scene)) {
    const sizes = new Map<string, Size>();
    for (const c of scene.nodes.get(id)?.children ?? []) {
      const own = containers[c];
      if (own) sizes.set(c, frameSize({ w: own.w, h: own.h }));
    }
    const graph = graphOf(scene, id, sizes, landed.get(id) ?? []);
    // The insight algorithms are ours: they are answered here, and only ELK's own algorithms reach the solver.
    const algorithm = graph.layoutOptions["elk.algorithm"];
    const solved = algorithm === "insight.columns" ? callColumns(graph) : algorithm === "rectpacking" ? packRows(graph) : await solve(graph);
    containers[id] = readLayout(graph, solved);
  }
  return { containers };
}

/** True when `layout` has a container for every scene node with children and a slot for every child. */
export function layoutCovers(scene: Scene, layout: SceneLayout): boolean {
  for (const [id, n] of scene.nodes) {
    if (n.children.length === 0) continue;
    const own = layout.containers[id];
    if (!own) return false;
    const slots = new Map(own.slots.map((s) => [s.id, s]));
    for (const c of n.children) {
      const slot = slots.get(c);
      if (!slot) return false;
      // A leaf's slot must still have the leaf's size: a layout saved before a chart changed would overlap its neighbours.
      if (scene.nodes.get(c)?.children.length === 0) {
        const s = sceneLeafSize(scene, c);
        if (slot.w !== s.w || slot.h !== s.h) return false;
      }
    }
  }
  return true;
}

/** Places the scene for an open set: open containers are frames with their children placed, closed nodes are boxes. */
export function placeSceneLayout(scene: Scene, layout: SceneLayout, open: ReadonlySet<string>, origin: { x: number; y: number } = { x: 0, y: 0 }): Placed {
  const items: PlacedItem[] = [];
  const rects = new Map<string, Rect>();
  const root = layout.containers[scene.root];
  if (!root) return { items, rects, width: 0, height: 0 };
  rects.set(scene.root, { x: origin.x, y: origin.y, w: root.w, h: root.h });
  const { pad, head } = ZOOM_SIZE;
  const visit = (container: string, ox: number, oy: number) => {
    const own = layout.containers[container];
    if (!own) return;
    for (const s of own.slots) {
      const rect = { x: ox + s.x, y: oy + s.y, w: s.w, h: s.h };
      rects.set(s.id, rect);
      const n = scene.nodes.get(s.id);
      const depth = sceneDepth(scene, s.id);
      if (n !== undefined && n.children.length > 0 && open.has(s.id) && layout.containers[s.id] !== undefined) {
        items.push({ id: s.id, kind: "frame", rect, inner: { x: rect.x + pad, y: rect.y + head, w: s.w - 2 * pad, h: s.h - head - pad }, depth });
        visit(s.id, rect.x + pad, rect.y + head);
      } else {
        items.push({ id: s.id, kind: "box", rect, depth });
      }
    }
  };
  visit(scene.root, origin.x, origin.y);
  return { items, rects, width: root.w, height: root.h };
}

/** The edges drawn for an open set, each with its curve between the two placed rectangles. */
export function placeSceneEdges(scene: Scene, open: ReadonlySet<string>, rects: ReadonlyMap<string, Rect>): (PlacedEdge & { kind: SceneEdgeKind; how?: string })[] {
  const out: (PlacedEdge & { kind: SceneEdgeKind; how?: string })[] = [];
  for (const e of sceneEdges(scene, open)) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b) continue;
    out.push({
      from: e.from,
      to: e.to,
      kind: e.kind,
      ...(e.how !== undefined ? { how: e.how } : {}),
      count: e.count,
      stubCount: 0,
      stub: false,
      candidate: e.candidate,
      d: edgeCurve(a, b),
    });
  }
  return out;
}

/** The deepest node under a world point among placed boxes; ties go to the smaller box. */
export function sceneFocusAt(scene: Scene, boxes: readonly { id: string; x: number; y: number; w: number; h: number }[], x: number, y: number): string | undefined {
  let best: { id: string; depth: number; area: number } | undefined;
  for (const b of boxes) {
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    const depth = sceneDepth(scene, b.id);
    const area = b.w * b.h;
    if (!best || depth > best.depth || (depth === best.depth && area < best.area)) best = { id: b.id, depth, area };
  }
  return best?.id;
}

/**
 * The scope tree as a scene: project, folder, file and function nodes, and the calls between tree nodes.
 *
 * Only calls with both ends in the tree become edges. Calls to externals are dropped, since the generic engine has no
 * stubs yet (the scope engine draws them as dashed stubs beside the container, see `stubsFor` in zoom-layout.ts).
 */
export function scopeScene(tree: ScopeTree, links: readonly ScopeLink[]): Scene {
  const nodes = new Map<string, SceneNode>();
  for (const [id, n] of tree.nodes) {
    const node: SceneNode = { id, kind: n.kind, label: n.kind === "project" ? "Project" : n.name, children: [...n.children], note: n.path };
    if (n.parent !== undefined) node.parent = n.parent;
    if (n.kind === "function") node.ref = id;
    else node.detail = `${n.functions} function${n.functions === 1 ? "" : "s"}`;
    nodes.set(id, node);
  }
  const edges: SceneEdge[] = [];
  for (const l of links) {
    if (!tree.nodes.has(l.from) || !tree.nodes.has(l.to)) continue;
    edges.push({ from: l.from, to: l.to, kind: "call", count: l.count, candidate: l.candidate });
  }
  return {
    root: PROJECT_ID,
    nodes,
    edges,
    levels: {
      project: { box: ZOOM_SIZE.folder, layout: LAYERED },
      folder: { box: ZOOM_SIZE.folder, layout: LAYERED },
      file: { box: ZOOM_SIZE.file, layout: LAYERED },
      function: { box: ZOOM_SIZE.fn, layout: LAYERED },
    },
  };
}
