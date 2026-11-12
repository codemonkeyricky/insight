// The zoom map's layout rules. Each open container lays out its children in its own graph. An open child takes the
// size of its expanded frame, so the frame has a slot of its own and its siblings move out of the way. The caller
// runs the layout (ELK, in a worker); this file builds the graph, reads the answer back and places every slot in
// the world. Pure data and arithmetic.
import { PROJECT_ID, boxOf, depthOf, mapEdges, type Rect, type ScopeLink, type ScopeTree } from "./scope-map.js";

export interface Size {
  w: number;
  h: number;
}

/** Sizes in world units. A collapsed box is the size a closed node takes in its parent's layout. */
export const ZOOM_SIZE = {
  file: { w: 220, h: 44 },
  folder: { w: 260, h: 60 },
  fn: { w: 230, h: 44 },
  stub: { w: 200, h: 40 },
  /** Room above an expanded frame's content for its header. */
  head: 30,
  /** Room around an expanded frame's content. */
  pad: 16,
} as const;

/** The options every container's layout uses: layers left to right, so callers sit to the left of callees. */
export const LAYERED: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

/** The size a node takes in its parent's layout when it is closed. An id the tree does not hold is a callee stub. */
export function collapsedSize(tree: ScopeTree, id: string): Size {
  const kind = tree.nodes.get(id)?.kind;
  if (kind === undefined) return ZOOM_SIZE.stub;
  if (kind === "file") return ZOOM_SIZE.file;
  if (kind === "function") return ZOOM_SIZE.fn;
  return ZOOM_SIZE.folder;
}

/** The size of a frame that holds content of `inner` size: the content plus the header and the padding. */
export function frameSize(inner: Size): Size {
  return { w: inner.w + 2 * ZOOM_SIZE.pad, h: inner.h + ZOOM_SIZE.head + ZOOM_SIZE.pad };
}

/**
 * The container whose layout shows a focus. A folder or file lays out its own children. A function's children are
 * none, so its file lays them out, and its chart takes the function's slot there.
 */
export function layoutContainerOf(tree: ScopeTree, focus: string): string {
  const n = tree.nodes.get(focus);
  if (n?.kind === "function") return n.parent ?? PROJECT_ID;
  return focus;
}

/** A graph in the shape ELK reads. Each child is sized already; each edge joins two children of the container. */
export interface LayoutGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: { id: string; width: number; height: number }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

/**
 * The graph a container lays out. `sizes` gives the expanded size of each open child; every other child is
 * collapsed. `stubs` are callee ids outside the tree that the container's calls reach; they sit beside the children.
 * A call between two boxes of the container (or a box and a stub) becomes an edge, so the solver orders the layers
 * by who calls whom. A call that reaches into a sibling is ignored here: the sibling is laid out by its own parent.
 */
export function layoutGraphOf(tree: ScopeTree, container: string, sizes: ReadonlyMap<string, Size>, stubs: readonly string[], links: readonly ScopeLink[]): LayoutGraph {
  const kids = tree.nodes.get(container)?.children ?? [];
  const kidSet = new Set(kids);
  const stubSet = new Set(stubs);
  const sized = (id: string, s: Size) => ({ id, width: s.w, height: s.h });
  const children = [
    ...kids.map((id) => sized(id, sizes.get(id) ?? collapsedSize(tree, id))),
    ...stubs.map((id) => sized(id, ZOOM_SIZE.stub)),
  ];
  // Only the container's children and its stubs are visible here, so boxOf climbs an endpoint to one of them.
  const visible = new Set<string>([...kidSet, ...stubSet]);
  const open = new Set<string>();
  const seen = new Set<string>();
  const edges: LayoutGraph["edges"] = [];
  for (const l of links) {
    const a = boxOf(tree, open, visible, l.from);
    const b = boxOf(tree, open, visible, l.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!visible.has(a) || !visible.has(b)) continue;
    const key = `${a}\u0000${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `e${edges.length}`, sources: [a], targets: [b] });
  }
  return { id: container, layoutOptions: LAYERED, children, edges };
}

/**
 * What a layout depends on, as a string: the container, the expanded sizes of its children, its stubs, and the
 * tree version the links came from. Two calls with the same key give the same layout, so the answer is cached.
 */
export function layoutKey(container: string, sizes: ReadonlyMap<string, Size>, stubs: readonly string[], version: number): string {
  const expanded = [...sizes]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, s]) => `${id}=${s.w}x${s.h}`)
    .join(",");
  return `${version}|${container}|${expanded}|${stubs.join(",")}`;
}

/** One child's place in its container's content, with its size. Positions are relative to the content's corner. */
export interface Slot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ContainerLayout {
  w: number;
  h: number;
  slots: Slot[];
}

/** Reads a layout result back. The sizes come from the graph, since the solver echoes them. */
export function readLayout(graph: LayoutGraph, laid: { width?: number; height?: number; children?: { id: string; x?: number; y?: number }[] }): ContainerLayout {
  const size = new Map(graph.children.map((c) => [c.id, c]));
  const slots: Slot[] = [];
  for (const c of laid.children ?? []) {
    const s = size.get(c.id);
    if (s) slots.push({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, w: s.width, h: s.height });
  }
  let w = laid.width ?? 0;
  let h = laid.height ?? 0;
  for (const s of slots) {
    w = Math.max(w, s.x + s.w);
    h = Math.max(h, s.y + s.h);
  }
  return { w, h, slots };
}

export type PlacedKind = "frame" | "box" | "stub" | "cfg";

export interface PlacedItem {
  id: string;
  kind: PlacedKind;
  /** The node's whole rectangle in the world: the frame for an open container, the box otherwise. */
  rect: Rect;
  /** Where a frame's content or a chart sits. A chart is drawn into this rectangle. */
  inner?: Rect;
  depth: number;
}

export interface Placed {
  items: PlacedItem[];
  /** Every placed node's rectangle, by id. */
  rects: Map<string, Rect>;
  /** The project's whole extent. */
  width: number;
  height: number;
}

/**
 * Places every slot of every laid-out container in the world. `origin` is the project's top-left corner. A frame's
 * children sit inside it, below the header. `cfg` names the focused function and the size of its chart, which takes
 * the function's slot in place of a box. Items come parent first, so a frame is drawn under its children.
 */
export function placeScene(tree: ScopeTree, layouts: ReadonlyMap<string, ContainerLayout>, origin: { x: number; y: number }, cfg?: { id: string; w: number; h: number }): Placed {
  const items: PlacedItem[] = [];
  const rects = new Map<string, Rect>();
  const root = layouts.get(PROJECT_ID);
  if (!root) return { items, rects, width: 0, height: 0 };
  rects.set(PROJECT_ID, { x: origin.x, y: origin.y, w: root.w, h: root.h });
  const { pad, head } = ZOOM_SIZE;
  const visit = (container: string, ox: number, oy: number) => {
    const layout = layouts.get(container);
    if (!layout) return;
    for (const s of layout.slots) {
      const rect = { x: ox + s.x, y: oy + s.y, w: s.w, h: s.h };
      rects.set(s.id, rect);
      if (!tree.nodes.has(s.id)) {
        items.push({ id: s.id, kind: "stub", rect, depth: -1 });
      } else if (cfg !== undefined && cfg.id === s.id) {
        items.push({ id: s.id, kind: "cfg", rect, inner: { x: rect.x + pad, y: rect.y + head, w: cfg.w, h: cfg.h }, depth: depthOf(tree, s.id) });
      } else if (layouts.has(s.id)) {
        items.push({ id: s.id, kind: "frame", rect, inner: { x: rect.x + pad, y: rect.y + head, w: s.w - 2 * pad, h: s.h - head - pad }, depth: depthOf(tree, s.id) });
        visit(s.id, rect.x + pad, rect.y + head);
      } else {
        items.push({ id: s.id, kind: "box", rect, depth: depthOf(tree, s.id) });
      }
    }
  };
  visit(PROJECT_ID, origin.x, origin.y);
  return { items, rects, width: root.w, height: root.h };
}

/** True when `id` is `container` or lies under it. */
export function isUnder(tree: ScopeTree, id: string, container: string): boolean {
  for (let cur: string | undefined = id; cur !== undefined; cur = tree.nodes.get(cur)?.parent) {
    if (cur === container) return true;
  }
  return false;
}

/**
 * The callee ids outside the tree that the container's calls reach, in id order. These are the stubs its layout
 * places. A call that reaches a tree node is drawn to that node's box, which an ancestor's layout already holds.
 */
export function stubsFor(tree: ScopeTree, links: readonly ScopeLink[], open: ReadonlySet<string>, container: string): string[] {
  const ids = new Set<string>();
  for (const e of mapEdges(tree, links, open, container)) {
    if (!tree.nodes.has(e.from) && isUnder(tree, e.to, container)) ids.add(e.from);
    if (!tree.nodes.has(e.to) && isUnder(tree, e.from, container)) ids.add(e.to);
  }
  return [...ids].sort();
}

export interface PlacedEdge {
  from: string;
  to: string;
  count: number;
  stubCount: number;
  stub: boolean;
  candidate: boolean;
  /** The curve's SVG path data, from the edge of one box to the edge of the other. */
  d: string;
}

/** The curve between two rectangles: it leaves the side that faces the other box and enters that box's facing side. */
export function edgeCurve(a: Rect, b: Rect): string {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
    const right = bx >= ax;
    const sx = right ? a.x + a.w : a.x;
    const ex = right ? b.x : b.x + b.w;
    const dx = Math.max(24, Math.abs(ex - sx) / 2) * (right ? 1 : -1);
    return `M${sx} ${ay} C${sx + dx} ${ay} ${ex - dx} ${by} ${ex} ${by}`;
  }
  const down = by >= ay;
  const sy = down ? a.y + a.h : a.y;
  const ey = down ? b.y : b.y + b.h;
  const dy = Math.max(24, Math.abs(ey - sy) / 2) * (down ? 1 : -1);
  return `M${ax} ${sy} C${ax} ${sy + dy} ${bx} ${ey - dy} ${bx} ${ey}`;
}

/**
 * The calls drawn on screen for an open set, each placed between its two boxes. A call with an end that has no
 * rectangle is skipped, since that end is off the map.
 */
export function placeEdges(tree: ScopeTree, links: readonly ScopeLink[], open: ReadonlySet<string>, focus: string, rects: ReadonlyMap<string, Rect>): PlacedEdge[] {
  const out: PlacedEdge[] = [];
  for (const e of mapEdges(tree, links, open, focus)) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b) continue;
    out.push({ from: e.from, to: e.to, count: e.count, stubCount: e.stubCount, stub: e.stub, candidate: e.candidate, d: edgeCurve(a, b) });
  }
  return out;
}
