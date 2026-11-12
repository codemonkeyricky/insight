import type { IREdge, IRNode, NodeId, UnresolvedRef } from "@insight/ir";
import type { IRView } from "./irview.js";
import { edgeTargets } from "./irview.js";

export interface TraceOptions {
  /** Edge kinds to follow. Subkinds are included. */
  follow: string[];
  /** "out" follows edges from a node (callees, imports). "in" follows edges into it (callers, importers). */
  direction?: "out" | "in";
  /** "may" also follows candidate sets. "exact" follows only single-target edges. */
  uncertain?: "may" | "exact";
  /** Hops beyond this depth are not followed. Default 16. */
  maxDepth?: number;
  /** A node for which this returns true is reached but not expanded. */
  stopAt?: (node: IRNode) => boolean;
}

export interface TraceDeadEnd {
  from: NodeId;
  edge: IREdge;
  unresolved: UnresolvedRef["unresolved"];
}

export interface Reach {
  /** Every node reached, including the start nodes, with its depth in hops. */
  readonly nodes: ReadonlyMap<NodeId, number>;
  /** Shortest path from a start node to the node, inclusive, or undefined when not reached. */
  pathsTo(id: NodeId): NodeId[] | undefined;
  /** Strongly connected groups of two or more nodes, or a node with an edge to itself. */
  readonly cycles: NodeId[][];
  /** Followed edges that stop at an unresolved reference. Reported, never silently dropped. */
  readonly deadEnds: TraceDeadEnd[];
}

/**
 * Walks chains of edges from start nodes. Each lens chooses its own edge kinds, direction and
 * depth. The IR never stores the result of a walk.
 */
export function trace(view: IRView, starts: NodeId[], opts: TraceOptions): Reach {
  const direction = opts.direction ?? "out";
  const uncertain = opts.uncertain ?? "may";
  const maxDepth = opts.maxDepth ?? 16;
  const kinds = new Set(opts.follow.flatMap((k) => view.registry.subkinds(k)));

  const depth = new Map<NodeId, number>();
  const parent = new Map<NodeId, NodeId>();
  const adjacency = new Map<NodeId, NodeId[]>();
  const deadEnds: TraceDeadEnd[] = [];
  let frontier: NodeId[] = [];
  for (const s of starts) {
    if (depth.has(s)) continue;
    depth.set(s, 0);
    frontier.push(s);
  }

  const addHop = (from: NodeId, to: NodeId) => {
    const list = adjacency.get(from);
    if (list) {
      if (!list.includes(to)) list.push(to);
    } else adjacency.set(from, [to]);
  };

  const visit = (from: NodeId, to: NodeId, depthOfTo: number, next: NodeId[]): void => {
    addHop(from, to);
    if (depth.has(to)) return;
    depth.set(to, depthOfTo);
    parent.set(to, from);
    next.push(to);
  };

  for (let d = 0; frontier.length > 0 && d < maxDepth; d++) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      // Start nodes are always expanded. Other reached nodes may be marked as stop points.
      const node = view.node(id);
      if (d > 0 && node && opts.stopAt?.(node)) continue;
      const edges = direction === "out" ? view.out(id) : view.in(id);
      for (const edge of edges) {
        if (!kinds.has(edge.kind)) continue;
        const targets = edgeTargets(edge);
        if (direction === "out") {
          if (targets.unresolved) {
            deadEnds.push({ from: id, edge, unresolved: targets.unresolved });
            continue;
          }
          const hops = [...targets.nodes];
          if (uncertain === "may") hops.push(...targets.candidates);
          for (const to of hops) visit(id, to, d + 1, next);
        } else {
          // Walking inward: the edge's source is reached when this node is one of its targets.
          const isExact = targets.nodes.includes(id);
          const isCandidate = targets.candidates.includes(id);
          if (!isExact && !(isCandidate && uncertain === "may")) continue;
          visit(id, edge.from, d + 1, next);
        }
      }
    }
    frontier = next;
  }

  return {
    nodes: depth,
    pathsTo(id: NodeId): NodeId[] | undefined {
      if (!depth.has(id)) return undefined;
      const path: NodeId[] = [id];
      let cur = id;
      while (parent.has(cur)) {
        cur = parent.get(cur) as NodeId;
        path.unshift(cur);
      }
      return path;
    },
    cycles: findCycles(depth.keys(), adjacency),
    deadEnds,
  };
}

/** Tarjan's algorithm over a hop graph. Returns the groups of two or more nodes that form a cycle, and self-loops. */
export function findCycles(nodes: Iterable<NodeId>, adjacency: Map<NodeId, NodeId[]>): NodeId[][] {
  let index = 0;
  const indexOf = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const out: NodeId[][] = [];

  const connect = (v: NodeId): void => {
    indexOf.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indexOf.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, indexOf.get(w) as number));
      }
    }
    if (low.get(v) === indexOf.get(v)) {
      const group: NodeId[] = [];
      let w: NodeId;
      do {
        w = stack.pop() as NodeId;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      const selfLoop = group.length === 1 && (adjacency.get(v) ?? []).includes(v);
      if (group.length > 1 || selfLoop) out.push(group.sort());
    }
  };

  for (const v of nodes) if (!indexOf.has(v)) connect(v);
  return out.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}
