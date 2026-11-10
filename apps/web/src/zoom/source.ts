// The zoom map's renderer-facing contract. ZoomMap draws whatever a MapSource builds: the execution canvas of a scope
// (ExecStore, execStore.ts), a scene of threads, coroutines, file groups and functions. A source loads what a focus
// needs and lays it out; the map only places the camera, culls, applies the open/close hysteresis and keeps the URL in
// step. Pure types and helpers, no DOM, so they are unit tested.
import type { Placed, PlacedEdge, SceneEdgeKind } from "@insight/flow";

/** One node as the map draws it. */
export interface MapNode {
  id: string;
  /** The kind, as a class: the box is drawn as `zm-box zm-<kind>` and an open frame as `zm-frame zm-<kind>`. */
  kind: string;
  /** The text in the box or the frame's header. */
  label: string;
  /** The muted text at the right of an open frame's header, such as "12 functions". */
  detail?: string;
  /** The tooltip. */
  title?: string;
  /** The parent's id. The root has none, so going up from the root does nothing. */
  parent?: string;
  /** The entity the box draws, such as the function id whose chart the box holds. */
  ref?: string;
  /** The source file a function is written in (a path, as the model names it). Used to group boxes into cards. */
  file?: string;
  /**
   * The natural size of the control-flow chart the box's expansion draws. The box itself is always drawn at its compact
   * size, with its name only.
   */
  chart?: { w: number; h: number };
}

/** An edge as the map draws it. A call has no kind (or "call"); spawns and dispatches get their own class. */
export type MapEdge = PlacedEdge & { kind?: SceneEdgeKind; how?: string };

/** Where the focused function runs, and where else. Set for a function focus only. */
export interface MapSelected {
  /** The function's id: the IR id that the URL's `fn` names. */
  ref: string;
  name: string;
  /** The file and 1-based line of the definition. `file` is "" when the IR has no source for the function. */
  file: string;
  line: number;
  /** The place the focused node runs: a thread, a coroutine in it, or no runtime at all (the no-runtime group). */
  runtime: "thread" | "coroutine" | "none";
  /** The thread's label, when the function runs on one. */
  thread?: string;
  /** The coroutine's label, when the function runs inside one. */
  coroutine?: string;
  /** The node's own note, such as the no-runtime explanation or an anonymous function's note. */
  note?: string;
  /** Each other place the function is drawn, with the node the map opens for it and a label for the link. */
  placements: { nodeId: string; label: string }[];
}

/** Everything the map draws for one focus. A new build replaces the old one whole. */
export interface MapBuild {
  /** The focus this build is for (see MapSource). */
  focus: string;
  /** The node the focus stands for: the id that placed items, edges and `node` use. Equal to `focus` for a plain id. */
  nodeId: string;
  /** The scope the build stands for. */
  path: string;
  placed: Placed;
  edges: MapEdge[];
  /** A drawn node. Undefined for an id that is not a node of the scene. */
  node(id: string): MapNode | undefined;
  /** Depth of a node: the root is 0, unknown ids are -1. */
  depth(id: string): number;
  /** The root first, down to the focus. */
  crumbs: MapNode[];
  /** For a function focus: what the function is and where it runs. */
  selected?: MapSelected;
  /**
   * A slotted build keeps room beside each opened box for its expansions (the layout reserves it, see rebuild), so the
   * expansions sit in the layout and never shift the columns.
   */
  slotted?: boolean;
  /** The room the build keeps beside each box (the footprint it was laid out with). */
  footprint?: ReadonlyMap<string, { w: number; h: number }>;
}

/** The URL that shows a focus: the scope, the function, and whether the map is the roots-only view. */
export interface MapUrl {
  scope: string;
  fn?: string;
  roots?: boolean;
}

/**
 * Where the map's scenes come from. A focus is what the map's state holds (what `show` takes), and a node id is what
 * the scene and the placed items name. For most sources they are the same string; a source whose node ids are not
 * unique across scopes makes the focus carry the scope and the node (see `focusOf`).
 */
export interface MapSource {
  /** Loads what a URL names and returns the focus it stands for. */
  resolve(scope: string, fn?: string): Promise<string>;
  /** Loads what a focus reached by a gesture needs before it is built. */
  ensureFocus(focus: string): Promise<void>;
  /** Lays out and places the map for a focus. The map's expansions are the map's own state, not the source's. */
  build(focus: string): Promise<MapBuild>;
  /** The URL (scope and function) that shows `focus` of `build`. Undefined when it has none. */
  url(build: MapBuild, focus: string): MapUrl | undefined;
  /**
   * The focus a node id of `build` stands for, when it is not the id itself. A click, a key or a link that names a node
   * calls this before `build`. Undefined from this method (or no method) means the node id is the focus.
   */
  focusOf?(build: MapBuild, nodeId: string): string;
  /**
   * The node of a function (by its IR id) that the build draws, preferably in the thread the build's node runs on. A
   * chart's call to a function in scope opens this node in place. Undefined when the scope does not draw the function.
   */
  placeFunction?(build: MapBuild, fnId: string): string | undefined;
  /**
   * Whether the build's model names the function by its IR id. A call to a name the model does not hold is a call to a
   * lambda folded into its owner: it has no box and no chart of its own, so the call highlights its block instead. Undefined
   * (no method) means every callee is a function.
   */
  isFunction?(build: MapBuild, fnId: string): boolean;
  /**
   * The build again, laid out with `footprint`: the room kept beside each box (see MapBuild.slotted). Synchronous, since the
   * layout is arithmetic. Only a slotted build is laid out again.
   */
  rebuild?(build: MapBuild, footprint: ReadonlyMap<string, { w: number; h: number }>): MapBuild;
  /** Whether a chain box's function is a dispatch target (an await or a start) of the thread that holds the box `boxId`. */
  asyncOf?(build: MapBuild, fnId: string, boxId: string): boolean;
}

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The deepest box under a world point; ties go to the smaller box. The same rule as focusAt and sceneFocusAt. */
export function deepestAt(boxes: readonly Box[], depth: (id: string) => number, x: number, y: number): string | undefined {
  let best: { id: string; depth: number; area: number } | undefined;
  for (const b of boxes) {
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    const d = depth(b.id);
    const area = b.w * b.h;
    if (!best || d > best.depth || (d === best.depth && area < best.area)) best = { id: b.id, depth: d, area };
  }
  return best?.id;
}

/**
 * The box nearest a world point, for a point in a gap between boxes. Only boxes at the deepest depth that has any box
 * within `maxDist` count. Among those, the nearest wins (distance from the point to the box's rectangle, 0 inside);
 * ties go to the smaller box, then to the smaller id. Undefined when no box is within `maxDist`.
 */
export function nearestBox(boxes: readonly Box[], depth: (id: string) => number, x: number, y: number, maxDist: number): string | undefined {
  let best: { id: string; depth: number; dist: number; area: number } | undefined;
  for (const b of boxes) {
    const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
    const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
    const dist = Math.hypot(dx, dy);
    if (!(dist <= maxDist)) continue;
    const d = depth(b.id);
    const area = b.w * b.h;
    const better =
      !best ||
      d > best.depth ||
      (d === best.depth &&
        (dist < best.dist || (dist === best.dist && (area < best.area || (area === best.area && b.id < best.id)))));
    if (better) best = { id: b.id, depth: d, dist, area };
  }
  return best?.id;
}

/**
 * The runtime a drawn frame or box runs on, which sets its line type on the sheet: a process (thick ink), a thread (thin
 * verdigris), a coroutine (dashed ochre) or none (dotted graphite, plain code with no runtime context).
 */
export type RuntimeLine = "process" | "thread" | "coroutine" | "none";

/**
 * The line type of a node of `kind`. A program is a process and a thread or coroutine is its own kind. A function takes
 * the line of the container it sits in (`parentLine`), so a function in a thread is drawn as thread code.
 */
export function runtimeLine(kind: string, parentLine: RuntimeLine = "none"): RuntimeLine {
  switch (kind) {
    case "program":
      return "process";
    case "thread":
      return "thread";
    case "coroutine":
      return "coroutine";
    case "function":
      return parentLine;
    default:
      return "none";
  }
}

/** The class a node is drawn with for its line type, such as `zm-line-thread`. */
export const lineClass = (line: RuntimeLine): string => `zm-line-${line}`;

/** The edge's classes: stubs dashed, candidates dotted, spawns and dispatches marked by kind, sync edges by what is shared. */
export function edgeClass(e: Pick<MapEdge, "stub" | "candidate" | "kind" | "how">): string {
  const base = e.stub ? "zm-edge stub" : e.candidate ? "zm-edge candidate" : "zm-edge";
  if (e.kind === "sync") return `${base} sync${e.how === "lock" || e.how === "channel" ? ` ${e.how}` : ""}`;
  return e.kind === "spawn" || e.kind === "dispatch" ? `${base} ${e.kind}` : base;
}

/** The edge's tooltip. */
export function edgeTitle(e: Pick<MapEdge, "stub" | "count" | "stubCount" | "kind" | "how">): string {
  if (e.kind === "sync" && e.how === "channel") return e.count === 1 ? "Sends on a channel the other receives" : `${e.count} channels from one to the other`;
  if (e.kind === "sync") return e.count === 1 ? "Both take the same lock" : `${e.count} locks both take`;
  if (e.kind === "spawn") return e.count === 1 ? "Spawns this" : `${e.count} spawns`;
  if (e.kind === "dispatch") return e.count === 1 ? "1 dispatch" : `${e.count} dispatches`;
  return e.stub ? `${e.count} calls, ${e.stubCount} leave the scope` : `${e.count} calls`;
}

/** The edge's stroke width in screen pixels: thicker for more calls, and a spawn one pixel thicker again. */
export function edgeWidth(e: Pick<MapEdge, "count" | "kind">): number {
  return Math.min(4, 1 + Math.log2(Math.max(1, e.count))) + (e.kind === "spawn" ? 1 : 0);
}

/** A key for an edge, unique within one build: two ends can be joined by a call and a dispatch. */
export const edgeKey = (e: Pick<MapEdge, "from" | "to" | "kind" | "how">): string =>
  `${e.from}\u0000${e.to}\u0000${e.kind ?? ""}\u0000${e.kind === "sync" ? (e.how ?? "") : ""}`;
