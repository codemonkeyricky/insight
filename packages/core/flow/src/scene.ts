// The generic scene the zoom canvas draws. A scene is a tree of nodes of any kinds, with edges between any two of its
// nodes. Each kind has a level: the size of its box when it has no children, and the layout options a container of
// that kind lays its children out with. The scope map (project, folder, file, function) and the execution canvas
// (program, thread, coroutine, function) are both scenes, so one engine lays them out and draws them.
//
// Pure data and arithmetic: the layout solver (ELK) is passed in, so the same code runs in the browser's worker and
// in the demo capture under Node.
import type { ContainerLayout, Size } from "./zoom-layout.js";

/** Room between a function box's edge and its chart, and above the chart for the function's name. */
export const CHART_PAD = 12;
export const CHART_HEAD = 28;

/** How one kind of node is drawn and laid out. */
export interface SceneLevel {
  /** The size of a node of this kind that has no children. A node with children takes its laid-out frame's size. */
  box: Size;
  /** The ELK options a container of this kind lays its children out with. Defaults to LAYERED (zoom-layout.ts). */
  layout?: Record<string, string>;
}

export interface SceneNode {
  id: string;
  /** A key of `Scene.levels`. */
  kind: string;
  /** The text in the box or the frame's header. */
  label: string;
  parent?: string;
  /** Child ids, in a fixed order. The order is part of the layout input, so it must not depend on input order. */
  children: string[];
  /** A short muted line, such as "12 functions". */
  detail?: string;
  /** A longer explanation, for the tooltip or a detail panel. */
  note?: string;
  /**
   * The entity the node draws, such as a function id. Several nodes can share a ref: a helper that two threads run
   * is drawn once in each thread.
   */
  ref?: string;
  /**
   * For a function that has a control-flow chart: the chart's natural size. The chart is drawn in an expansion beside the
   * map (see apps/web/src/zoom/expand.ts), never in the box, so the box does not depend on it.
   */
  chart?: Size;
  /** For a function with a chart: the box's size, just its name. This is the size the box is always laid out at. */
  compact?: Size;
  /**
   * A thread that is an external command: a process spawn whose target the IR cannot resolve to a function, so the thread
   * has no functions. It is a leaf, drawn as a plain chip with no function glyph, and it opens nothing when clicked.
   */
  external?: boolean;
  /** The tooltip of a frame's header or a box, when it is not the note: a program's entry file path. */
  title?: string;
  /**
   * A thread whose code writes shared state another thread also writes with no lock held in common at every write
   * (`⚠ unguarded shared state`): the variable names. The map draws the badge on the thread's box.
   */
  unguarded?: string[];
  /**
   * A card (see unrooted.ts) whose function shares these sync resources with threads it reaches: a sync edge whose two ends
   * both land on this card, which the renderer cannot draw as an edge, so the resources are kept here. The map draws the
   * `⇆ N` badge on the card.
   */
  syncSelf?: SceneSyncResource[];
  /**
   * A card (see unrooted.ts) whose display name another card in the grid shares: the name with its file's stem after it
   * ("main · guideplan"), which the map draws in place of the name. The label, the tooltip and the id keep the full name.
   */
  shownName?: string;
}

/**
 * How an edge relates its two ends. `sync` joins two threads through the locks, channels, condition variables,
 * semaphores or atomics they both use: `resources` names them and `how` is the first one's kind.
 */
export type SceneEdgeKind = "call" | "spawn" | "dispatch" | "sync";

/** A resource a sync edge names: its identity in the IR and its kind. */
export interface SceneSyncResource {
  name: string;
  kind: "lock" | "channel" | "condvar" | "semaphore" | "atomic";
}

/** An edge between two scene nodes, at any depth. The engine draws it between the boxes that stand for its ends. */
export interface SceneEdge {
  from: string;
  to: string;
  kind: SceneEdgeKind;
  /** Calls or sites the edge stands for. For a sync edge, one per resource pair it merges. */
  count: number;
  /**
   * For a spawn or dispatch: the `how` of the IR edge (thread, process, async, await, start, callback, ...). For a sync
   * edge: the kind of its first resource.
   */
  how?: string;
  /** Set when the edge is one of several possible targets of one site. */
  candidate?: boolean;
  /** For a sync edge: every resource the two ends share, deduped by name and kind, in the order they were added. */
  resources?: SceneSyncResource[];
  /** For a sync edge: true when it runs from sender to receiver (a channel); false for two peers (a lock or the like). */
  directed?: boolean;
}

/**
 * The map key of a sync edge: a directed edge keeps its direction; an undirected one keys its two ends in code-unit
 * order, so the same pair of boxes made either way is one edge.
 */
export function syncEdgeKey(from: string, to: string, directed: boolean): string {
  if (directed) return `${from}\u0000${to}\u0000directed`;
  const [a, b] = from < to ? [from, to] : [to, from];
  return `${a}\u0000${b}\u0000undirected`;
}

/** Adds each resource of `more` to `into` that it does not hold yet, by name and kind. Returns `into`. */
export function addSyncResources(into: SceneSyncResource[], more: readonly SceneSyncResource[]): SceneSyncResource[] {
  for (const r of more) {
    if (!into.some((x) => x.name === r.name && x.kind === r.kind)) into.push({ name: r.name, kind: r.kind });
  }
  return into;
}

export interface Scene {
  /** The root node's id. The root is always open: the canvas shows its children. */
  root: string;
  nodes: Map<string, SceneNode>;
  edges: SceneEdge[];
  /** Every node kind the scene uses, with its level. */
  levels: Record<string, SceneLevel>;
}

/**
 * A scene laid out whole: every container's children are placed, each open child at its full frame size. Zooming
 * changes only which containers are drawn open, never where anything sits, so one layout serves every focus and can
 * be computed ahead of time. Keyed by container id; slot positions are relative to the container's content corner.
 */
export interface SceneLayout {
  containers: Record<string, ContainerLayout>;
}
