import type { NodeId } from "@insight/ir";
import { findCycles } from "@insight/sdk";
import type { ProjectModel, RelKind } from "./model.js";
import { cmp, describe, folded, order } from "./refs-common.js";
import type { RefRow } from "./refs.js";
import type { ScopeView } from "./view.js";

export interface CallerOptions {
  maxDepth?: number;        // default from P0 sizing; hops past it are not expanded
  maxNodes?: number;        // default from P0 sizing; the graph stops growing past it
  possible?: boolean;       // follow candidate sets and value references (default false; rows are listed either way)
  stayInScope?: boolean;    // callers outside the view are listed but not expanded (default false)
}

export interface CallerNode {
  id: NodeId;
  name: string; file: string; line: number;   // as RefRow (describe())
  isFunction: boolean;
  inScope: boolean;
  depth: number;                               // shortest hop count from the root
  /** Exact when some path from the root uses only exact relations; possible otherwise. */
  certainty: "exact" | "possible";
  /** Why this node's callers were not expanded. Absent when they were. */
  stop?: "none" | "module" | "outside-scope" | "depth" | "nodes" | "possible-off";
  /** Callers that exist but were left out by a cap (for "+N more"). */
  hidden?: number;
  /** Blind spots on this node: passed as a value, or the target of a truncated candidate set. */
  blind?: Array<"value" | "truncated">;
}

export interface CallerEdge {
  from: NodeId;             // the caller
  to: NodeId;               // the callee, nearer the root
  kind: RelKind; how?: string; label?: string;
  candidate: boolean;       // every relation of the group is a candidate
  count: number;            // relations collapsed into this edge
  site?: { file: string; line: number };       // first call site, as rowsOf
  /** True when `from` is in the same strongly connected group as `to` and not deeper: the edge closes a cycle. */
  back: boolean;
}

export interface CallerGraph {
  root: NodeId;
  nodes: CallerNode[];      // root first, then BFS order (refsOf's order() within a level)
  edges: CallerEdge[];      // sorted by (to, order of from)
  cycles: NodeId[][];       // findCycles over the discovered subgraph
  truncated?: { reason: "depth" | "nodes"; at: number };
  /** Counts for the summary line and the completeness note. */
  stats: { callers: number; levels: number; possible: number; blind: number; outsideScope: number };
}

/**
 * Sized on the insight and cognition indexes: depth 10 holds the whole chain for 97% of functions, 250 nodes holds the largest
 * chain seen (203). hardMaxDepth and hardMaxNodes are the ceilings a caller's maxDepth and maxNodes are clamped to.
 */
export const CALLER_DEFAULTS = { maxDepth: 10, maxNodes: 250, hardMaxDepth: 50, hardMaxNodes: 1000 };

/** Hows of a reference that are calls in effect. Every other reference is a possible caller. */
const CALL_LIKE_HOWS = new Set(["new", "jsx", "handler"]);

interface Site { file: string; line: number }

/** One (caller, kind, label) group of folded relations into the node being expanded. */
interface Group {
  row: RefRow;               // describe() of the caller
  kind: RelKind;
  label?: string;
  how?: string;
  candidate: boolean;
  count: number;
  site?: Site;
  possible: boolean;
}

/** A node of one walk, with indices into the walk's node list. */
interface Work {
  row: RefRow;
  depth: number;
  isFile: boolean;
  stop?: CallerNode["stop"];
  hidden?: number;
}

interface Edge {
  from: number;
  to: number;
  group: Group;
}

interface Walk {
  nodes: Work[];
  edges: Edge[];
  truncated?: CallerGraph["truncated"];
}

interface Config {
  maxDepth: number;
  maxNodes: number;
  possible: boolean;
  stayInScope: boolean;
}

/**
 * The bounded caller chain of a function: every function (or file) that calls or references it, transitively, found by a
 * breadth-first walk over the folded incoming relations of the project model.
 */
export function callerGraph(view: ScopeView, id: NodeId, opts: CallerOptions = {}): CallerGraph {
  const { model } = view;
  if (!model.byId.has(id)) return { root: id, nodes: [], edges: [], cycles: [], stats: { callers: 0, levels: 0, possible: 0, blind: 0, outsideScope: 0 } };

  const cfg: Config = {
    maxDepth: Math.max(1, Math.min(CALLER_DEFAULTS.hardMaxDepth, Math.floor(numberOr(opts.maxDepth, CALLER_DEFAULTS.maxDepth)))),
    maxNodes: Math.max(1, Math.floor(Math.min(numberOr(opts.maxNodes, CALLER_DEFAULTS.maxNodes), CALLER_DEFAULTS.hardMaxNodes))),
    possible: opts.possible === true,
    stayInScope: opts.stayInScope === true,
  };

  // A node reached only through possible relations is not expanded, unless the walk finds an exact path to it.
  // Each pass adds such nodes to `forced`. A forced node that a later pass no longer reaches exactly (its exact path was
  // cut by maxNodes) is dropped from `forced` and banned from being forced again, so every expanded node is exact in the
  // final walk. A node is forced at most once and banned at most once, so the loop ends. The groups of each node are the
  // same in every pass, so the passes share one cache.
  const groupCache = new Map<NodeId, Group[]>();
  const banned = new Set<NodeId>();
  let forced = new Set<NodeId>();
  let walked = walk(view, id, cfg, forced, groupCache);
  for (;;) {
    const exact = exactSet(walked);
    const admitted = new Map<NodeId, number>(walked.nodes.map((n, i) => [n.row.id, i]));
    const stale = [...forced].filter((fid) => {
      const i = admitted.get(fid);
      return i === undefined || !exact.has(i);
    });
    const more = walked.nodes
      .filter((n, i) => n.stop === "possible-off" && exact.has(i) && !forced.has(n.row.id) && !banned.has(n.row.id))
      .map((n) => n.row.id);
    if (more.length === 0 && stale.length === 0) break;
    for (const fid of stale) banned.add(fid);
    forced = new Set([...forced].filter((fid) => !banned.has(fid)).concat(more));
    walked = walk(view, id, cfg, forced, groupCache);
  }
  const exact = exactSet(walked);
  const { nodes: work, edges: walkEdges } = walked;

  // A node with no line of its own (a file) takes the first call site of its outgoing edges.
  for (let i = 0; i < work.length; i++) {
    const n = work[i] as Work;
    if (n.row.line !== 0) continue;
    const first = walkEdges.find((e) => e.from === i && e.group.site !== undefined);
    if (first?.group.site) n.row = { ...n.row, line: first.group.site.line };
  }

  // A node the fixpoint banned from re-forcing can end exact while still stopped as possible-off. It was cut by the node
  // cap, not by the possible-relation rule, so it reads as capped: its hidden callers are the distinct callers of its groups.
  let truncated = walked.truncated;
  for (let i = 0; i < work.length; i++) {
    const n = work[i] as Work;
    if (n.stop !== "possible-off" || !exact.has(i)) continue;
    n.stop = "nodes";
    const hidden = new Set(groupsOf(view, n.row.id, groupCache).map((g) => g.row.id)).size;
    if (hidden > 0) n.hidden = hidden;
    truncated ??= { reason: "nodes", at: cfg.maxNodes };
  }

  // Nodes sort by depth, then refsOf's order() within a depth. The root is the only node at depth 0.
  const sorted = work.map((_, i) => i).sort((a, b) => {
    const x = work[a] as Work;
    const y = work[b] as Work;
    return x.depth - y.depth || order(x.row, y.row);
  });
  const pos = new Array<number>(sorted.length);
  sorted.forEach((old, p) => (pos[old] = p));
  const idOf = (old: number): NodeId => (work[old] as Work).row.id;
  const nodeIds = sorted.map(idOf);
  const depthOf = new Map<NodeId, number>(sorted.map((old) => [idOf(old), (work[old] as Work).depth]));

  // Edges sort by the position of their callee, then of their caller.
  const ordered = walkEdges
    .map((e) => ({ e, fromPos: pos[e.from] as number, toPos: pos[e.to] as number }))
    .sort((a, b) => a.toPos - b.toPos || a.fromPos - b.fromPos || cmp(a.e.group.kind, b.e.group.kind) || cmp(a.e.group.label ?? "", b.e.group.label ?? ""));

  // Cycles run over callee to caller, as the spec asks.
  const adjacency = new Map<NodeId, NodeId[]>();
  for (const { e } of ordered) {
    const to = idOf(e.to);
    const list = adjacency.get(to);
    if (list) list.push(idOf(e.from));
    else adjacency.set(to, [idOf(e.from)]);
  }
  const cycles = findCycles(nodeIds, adjacency);
  const groupOf = new Map<NodeId, number>();
  cycles.forEach((group, gi) => group.forEach((member) => groupOf.set(member, gi)));

  const edges: CallerEdge[] = ordered.map(({ e }) => {
    const from = idOf(e.from);
    const to = idOf(e.to);
    const g = e.group;
    const gFrom = groupOf.get(from);
    const sameGroup = gFrom !== undefined && gFrom === groupOf.get(to);
    const back = from === to || (sameGroup && (depthOf.get(from) as number) <= (depthOf.get(to) as number));
    return {
      from,
      to,
      kind: g.kind,
      ...(g.how !== undefined ? { how: g.how } : {}),
      ...(g.label !== undefined ? { label: g.label } : {}),
      candidate: g.candidate,
      count: g.count,
      ...(g.site ? { site: g.site } : {}),
      back,
    };
  });

  const nodes: CallerNode[] = sorted.map((old) => {
    const n = work[old] as Work;
    const r = n.row;
    const blind = blindOf(model, r.id);
    return {
      id: r.id,
      name: r.name,
      file: r.file,
      line: r.line,
      isFunction: r.isFunction,
      inScope: r.inScope,
      depth: n.depth,
      certainty: exact.has(old) ? "exact" : "possible",
      ...(n.stop !== undefined ? { stop: n.stop } : {}),
      ...(n.hidden !== undefined ? { hidden: n.hidden } : {}),
      ...(blind.length > 0 ? { blind } : {}),
    };
  });

  return {
    root: id,
    nodes,
    edges,
    cycles,
    ...(truncated ? { truncated } : {}),
    stats: {
      callers: nodes.length - 1,
      levels: Math.max(0, ...nodes.map((n) => n.depth)),
      possible: nodes.filter((n) => n.certainty === "possible").length,
      blind: nodes.filter((n) => n.blind !== undefined).length,
      outsideScope: nodes.filter((n) => !n.inScope).length,
    },
  };
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : fallback;
}

/** One breadth-first pass. Nodes are admitted in queue order, so a level is complete before the next one starts. */
function walk(view: ScopeView, id: NodeId, cfg: Config, forced: ReadonlySet<NodeId>, groupCache: Map<NodeId, Group[]>): Walk {
  const { model } = view;
  const nodes: Work[] = [{ row: describe(view, id, "call"), depth: 0, isFile: isFile(model, id) }];
  const index = new Map<NodeId, number>([[id, 0]]);
  const edges: Edge[] = [];
  let truncated: CallerGraph["truncated"];

  for (let i = 0; i < nodes.length; i++) {
    const x = nodes[i] as Work;
    const root = i === 0;
    const xid = x.row.id;

    // The checks that stop a node's expansion run before the depth cap, so a node that would not be expanded anyway is
    // not reported as cut off by depth.
    if (x.isFile || !(x.row.isFunction || root)) {
      x.stop = "module";
      continue;
    }
    if (cfg.stayInScope && !root && !x.row.inScope) {
      x.stop = "outside-scope";
      continue;
    }
    if (!cfg.possible && !root && !forced.has(xid)) {
      x.stop = "possible-off";
      continue;
    }
    if (x.depth >= cfg.maxDepth) {
      const hidden = new Set(groupsOf(view, xid, groupCache).map((g) => g.row.id)).size;
      if (hidden > 0) {
        x.stop = "depth";
        x.hidden = hidden;
        truncated ??= { reason: "depth", at: cfg.maxDepth };
      } else {
        x.stop = "none";
      }
      continue;
    }

    const groups = groupsOf(view, xid, groupCache);
    if (groups.length === 0) {
      x.stop = "none";
      continue;
    }
    const dropped = new Set<NodeId>();
    let recorded = 0;
    for (const g of groups) {
      let k = index.get(g.row.id);
      if (k === undefined) {
        if (nodes.length >= cfg.maxNodes) {
          dropped.add(g.row.id);
          truncated ??= { reason: "nodes", at: x.depth + 1 };
          continue;
        }
        k = nodes.length;
        index.set(g.row.id, k);
        nodes.push({ row: g.row, depth: x.depth + 1, isFile: isFile(model, g.row.id) });
      }
      edges.push({ from: k, to: i, group: g });
      recorded++;
    }
    if (dropped.size > 0) {
      x.hidden = dropped.size;
      if (recorded === 0) x.stop = "nodes";
    }
  }
  return { nodes, edges, ...(truncated ? { truncated } : {}) };
}

/** The (caller, kind, label) groups of the relations into `id`, folded as refsOf folds them, in a fixed order. */
function groupsOf(view: ScopeView, id: NodeId, cache: Map<NodeId, Group[]>): Group[] {
  const cached = cache.get(id);
  if (cached) return cached;
  const groups = computeGroups(view, id);
  cache.set(id, groups);
  return groups;
}

function computeGroups(view: ScopeView, id: NodeId): Group[] {
  const { model } = view;
  const raw = new Map<string, { other: NodeId; kind: RelKind; label?: string; how?: string; candidate: boolean; count: number; site?: Site }>();
  for (const rel of model.in.get(id) ?? []) {
    const { other, label } = folded(model, rel);
    const key = `${other}\0${rel.kind}\0${label ?? ""}`;
    const site = rel.edge.span ? { file: rel.edge.span.file, line: rel.edge.span.start[0] + 1 } : undefined;
    const g = raw.get(key);
    if (g) {
      g.count++;
      g.candidate &&= rel.candidate;
      if (rel.how !== undefined && (g.how === undefined || rel.how < g.how)) g.how = rel.how;
      if (site && (!g.site || site.file < g.site.file || (site.file === g.site.file && site.line < g.site.line))) g.site = site;
      continue;
    }
    raw.set(key, {
      other,
      kind: rel.kind,
      ...(label !== undefined ? { label } : {}),
      ...(rel.how !== undefined ? { how: rel.how } : {}),
      candidate: rel.candidate,
      count: 1,
      ...(site ? { site } : {}),
    });
  }
  const groups = [...raw.values()].map((g): Group => ({
    row: describe(view, g.other, g.kind),
    kind: g.kind,
    ...(g.label !== undefined ? { label: g.label } : {}),
    ...(g.how !== undefined ? { how: g.how } : {}),
    candidate: g.candidate,
    count: g.count,
    ...(g.site ? { site: g.site } : {}),
    possible: g.candidate || (g.kind === "reference" && !CALL_LIKE_HOWS.has(g.how ?? "")),
  }));
  return groups.sort((a, b) => order(a.row, b.row) || cmp(a.kind, b.kind) || cmp(a.label ?? "", b.label ?? ""));
}

/** Nodes reached from the root through exact edges only, as indices into the walk's nodes. */
function exactSet(walked: Walk): Set<number> {
  const callersOf = new Map<number, number[]>();
  for (const e of walked.edges) {
    if (e.group.possible) continue;
    const list = callersOf.get(e.to);
    if (list) list.push(e.from);
    else callersOf.set(e.to, [e.from]);
  }
  const reached = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const next = queue.pop() as number;
    for (const from of callersOf.get(next) ?? []) {
      if (!reached.has(from)) {
        reached.add(from);
        queue.push(from);
      }
    }
  }
  return reached;
}

function blindOf(model: ProjectModel, id: NodeId): Array<"value" | "truncated"> {
  const incoming = model.in.get(id) ?? [];
  const blind: Array<"value" | "truncated"> = [];
  if (incoming.some((rel) => rel.kind === "reference" && (rel.how === "value" || rel.how === "closure") && folded(model, rel).other !== id)) blind.push("value");
  if (incoming.some((rel) => (rel.edge.attrs as Record<string, unknown> | undefined)?.truncated === true)) blind.push("truncated");
  return blind;
}

function isFile(model: ProjectModel, id: NodeId): boolean {
  return model.byId.get(id)?.kind === "structure.file";
}
