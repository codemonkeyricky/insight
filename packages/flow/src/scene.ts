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
}

/**
 * How an edge relates its two ends. `sync` joins two threads through a lock or channel they both use: `how` is `lock`
 * or `channel`.
 */
export type SceneEdgeKind = "call" | "spawn" | "dispatch" | "sync";

/** An edge between two scene nodes, at any depth. The engine draws it between the boxes that stand for its ends. */
export interface SceneEdge {
  from: string;
  to: string;
  kind: SceneEdgeKind;
  /** Calls or sites the edge stands for. */
  count: number;
  /** For a spawn or dispatch: the `how` of the IR edge (thread, process, async, await, start, callback, ...). */
  how?: string;
  /** Set when the edge is one of several possible targets of one site. */
  candidate?: boolean;
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
