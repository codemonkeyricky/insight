import type { FlowNode, FunctionFlow, ScopeFlow, ScopeFlowStats } from "@insight/flow";
import { hrefView, inScope } from "./router";

/** The file of an IR id such as `src/lib/math.ts#add`: the part before the '#'. An id with no '#' names a file. */
export function fileOfId(id: string): string {
  const at = id.indexOf("#");
  return at === -1 ? id : id.slice(0, at);
}

/** The name in an IR id such as `src/lib/math.ts#Counter.increment`: the part after the '#'. */
export function nameOfId(id: string): string {
  const at = id.indexOf("#");
  return at === -1 ? id : id.slice(at + 1);
}

/** True when a callee in `target` lies outside `scope`, so a chart of `scope` cannot resolve the call. */
export function outsideScope(target: string, scope: string): boolean {
  return !inScope(fileOfId(target), scope);
}

/**
 * The nearest scope that holds `file`: the smallest folder on the way up from `scope` (the scope itself
 * counts), or the project. Selecting that scope resolves a call to a function in `file`.
 */
export function nearestScopeContaining(scope: string, file: string): string {
  const parts = scope === "" ? [] : scope.split("/");
  for (let n = parts.length; n > 0; n--) {
    const folder = parts.slice(0, n).join("/");
    if (inScope(file, folder)) return folder;
  }
  return "";
}

/** Where a call to `target` made from a view of `scope` is resolved: the file it lands in and the scope that holds it. */
export function outsideCall(target: string, scope: string): { file: string; scope: string } {
  const file = fileOfId(target);
  return { file, scope: nearestScopeContaining(scope, file) };
}

/** The sentence that says why a call step is unresolved. */
export function outsideText(target: string): string {
  return `calls ${nameOfId(target)} in ${fileOfId(target)} — outside this scope. Select a parent folder to resolve it.`;
}

/** The share of a scope's calls that resolve inside it, rounded. Undefined when the scope has no calls. */
export function resolutionPercent(stats: Pick<ScopeFlowStats, "calls" | "resolved">): number | undefined {
  return stats.calls === 0 ? undefined : Math.round((stats.resolved / stats.calls) * 100);
}

/** One directed link between two nodes of a graph, by key. */
export interface Link {
  from: string;
  to: string;
}

function adjacency(links: readonly Link[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const l of links) {
    const list = next.get(l.from);
    if (list) list.push(l.to);
    else next.set(l.from, [l.to]);
  }
  return next;
}

/**
 * The roots a breadth-first layout starts from. Every entry is a root. Then each part of the graph that
 * no root reaches gets one: first a node that nothing calls, then any node, so a cycle with no entry still
 * lays out in layers. Keys are taken in order.
 */
export function callRoots(keys: readonly string[], links: readonly Link[], entries: readonly string[]): string[] {
  const known = new Set(keys);
  const inScopeLinks = links.filter((l) => known.has(l.from) && known.has(l.to));
  const next = adjacency(inScopeLinks);
  const called = new Set(inScopeLinks.map((l) => l.to));
  const reached = new Set<string>();
  const roots: string[] = [];
  const reach = (start: string) => {
    roots.push(start);
    reached.add(start);
    const queue = [start];
    for (const cur of queue) {
      for (const to of next.get(cur) ?? []) {
        if (reached.has(to)) continue;
        reached.add(to);
        queue.push(to);
      }
    }
  };
  for (const e of entries) if (known.has(e) && !reached.has(e)) reach(e);
  for (const k of keys) if (!reached.has(k) && !called.has(k)) reach(k);
  for (const k of keys) if (!reached.has(k)) reach(k);
  return roots;
}

/**
 * The chain of nodes from a root down to `target` along the shortest route, root first. Only a target that
 * no root reaches comes back alone.
 */
export function callPath(roots: readonly string[], links: readonly Link[], target: string): string[] {
  const next = adjacency(links);
  const parent = new Map<string, string | null>();
  for (const r of roots) if (!parent.has(r)) parent.set(r, null);
  const queue = [...parent.keys()];
  for (const cur of queue) {
    for (const to of next.get(cur) ?? []) {
      if (parent.has(to)) continue;
      parent.set(to, cur);
      queue.push(to);
    }
  }
  if (!parent.has(target)) return [target];
  const path: string[] = [];
  for (let cur: string | null | undefined = target; cur !== null && cur !== undefined; cur = parent.get(cur)) path.unshift(cur);
  return path;
}

/**
 * The layer of each key: the number of calls on the shortest route from a root, so a root is 0. A key that
 * no root reaches is 0 too.
 */
export function layerDepths(keys: readonly string[], roots: readonly string[], links: readonly Link[]): Map<string, number> {
  const next = adjacency(links);
  const depth = new Map<string, number>();
  for (const r of roots) if (!depth.has(r)) depth.set(r, 0);
  const queue = [...depth.keys()];
  for (const cur of queue) {
    for (const to of next.get(cur) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, (depth.get(cur) ?? 0) + 1);
      queue.push(to);
    }
  }
  for (const k of keys) if (!depth.has(k)) depth.set(k, 0);
  return depth;
}

/** The size of one node cell and the gaps between cells and layers, in layout units. */
export interface Cell {
  w: number;
  h: number;
  gapX: number;
  gapY: number;
  layerGap: number;
}

/** One item to place: its key, the layer it sits in, and the text its layer is ordered by. */
export interface GridCell {
  key: string;
  layer: number;
  sort: string;
}

/** Where each key sits, and the size the whole grid takes up. */
export interface Grid {
  at: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A layered grid. Layers stack from the top in order. Within a layer the items fill rows of `cols`, in the
 * order of their `sort` text, so one file's functions sit next to each other.
 */
export function gridLayout(cells: readonly GridCell[], cols: number, size: Cell): Grid {
  const byLayer = new Map<number, GridCell[]>();
  for (const c of cells) {
    const list = byLayer.get(c.layer);
    if (list) list.push(c);
    else byLayer.set(c.layer, [c]);
  }
  const at = new Map<string, { x: number; y: number }>();
  let top = 0;
  let width = 0;
  for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
    const members = (byLayer.get(layer) ?? []).sort((a, b) => byText(a.sort, b.sort) || byText(a.key, b.key));
    members.forEach((c, i) => {
      at.set(c.key, { x: (i % cols) * (size.w + size.gapX), y: top + Math.floor(i / cols) * (size.h + size.gapY) });
    });
    width = Math.max(width, Math.min(cols, members.length) * (size.w + size.gapX) - size.gapX);
    top += Math.ceil(members.length / cols) * (size.h + size.gapY) + size.layerGap;
  }
  return { at, width, height: Math.max(0, top - size.layerGap) };
}

/** The cell a call graph's node takes, and the number of columns its rows wrap at. */
export const NODE_CELL: Cell = { w: 170, h: 44, gapX: 18, gapY: 16, layerGap: 40 };
export const GRID_COLUMNS = 6;

export const fnKey = (id: string) => `fn:${id}`;
const fileKey = (file: string) => `file:${file}`;
const moduleKey = (file: string) => `mod:${file}`;
const extKey = (id: string) => `ext:${id}`;

export type GraphKind = "function" | "module" | "file" | "external";

/** A node of the call graph. Externals are callees outside the scope. */
export interface GraphNode {
  /** Unique within the graph. Edges refer to nodes by this key. */
  key: string;
  kind: GraphKind;
  /** The name a list shows: a function name, a file path, or a callee's name. */
  name: string;
  /** Short text on the node. */
  label: string;
  /** Full text, for the tooltip. */
  title: string;
  /** The file a function, module or file node belongs to. */
  file?: string;
  entry: boolean;
  calledFromOutside: boolean;
  /** Where a click on the node goes. */
  href: string;
  /** For an external: the nearest scope that resolves it. */
  resolvedIn?: string;
}

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  count: number;
  external: boolean;
  candidate: boolean;
}

export interface CallGraph {
  granularity: ScopeFlow["granularity"];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Where a layout starts: the entries, then one node for each part no entry reaches. */
  roots: string[];
  byKey: Map<string, GraphNode>;
}

/**
 * The call graph of a scope's flow, ready for a canvas. In files granularity each file is a node; otherwise
 * each function is one. Module-level code is a node of its own, so a call made while a module loads has a
 * caller.
 */
export function callGraph(id: string, flow: ScopeFlow, scope: string): CallGraph {
  const perFile = flow.granularity === "files";
  const fnIds = new Set(flow.functions.map((f) => f.id));
  const entries = flow.entries.map((e) => (perFile ? fileKey(e) : fnKey(e)));
  const entrySet = new Set(entries);
  const extNames = new Map(flow.externals.map((e) => [e.id, e.name]));
  const nodes = new Map<string, GraphNode>();

  const put = (n: GraphNode) => {
    if (!nodes.has(n.key)) nodes.set(n.key, n);
  };

  if (perFile) {
    for (const f of flow.files) {
      const key = fileKey(f.file);
      put({
        key,
        kind: "file",
        name: f.file,
        label: f.file,
        title: `${f.file}: ${f.functions} functions, ${f.decisions} decisions`,
        file: f.file,
        entry: entrySet.has(key),
        calledFromOutside: f.calledFromOutside === true,
        href: hrefView(id, "flow", { scope: f.file }),
      });
    }
  } else {
    for (const f of flow.functions) {
      const key = fnKey(f.id);
      put({
        key,
        kind: "function",
        name: f.name,
        label: f.name,
        title: f.id,
        file: f.file,
        entry: entrySet.has(key),
        calledFromOutside: f.calledFromOutside === true,
        href: hrefView(id, "flow", { scope, fn: f.id }),
      });
    }
  }

  const callerKey = (from: string): string => {
    if (perFile) return fileKey(from);
    if (fnIds.has(from)) return fnKey(from);
    const key = moduleKey(from);
    put({
      key,
      kind: "module",
      name: `${from} module code`,
      label: "module code",
      title: `${from}: code that runs when the module loads`,
      file: from,
      entry: false,
      calledFromOutside: false,
      href: hrefView(id, "flow", { scope: from }),
    });
    return key;
  };

  const edges: GraphEdge[] = [];
  flow.calls.forEach((row, i) => {
    const from = callerKey(row.from);
    let to: string;
    if (row.external) {
      to = extKey(row.to);
      if (!nodes.has(to)) {
        const out = outsideCall(row.to, scope);
        const name = extNames.get(row.to) ?? (perFile ? row.to : nameOfId(row.to));
        put({
          key: to,
          kind: "external",
          name,
          label: `${name} ↗ outside scope`,
          title: `${row.to}: outside this scope`,
          entry: false,
          calledFromOutside: false,
          href: hrefView(id, "flow", perFile ? { scope: out.scope } : { scope: out.scope, fn: row.to }),
          resolvedIn: out.scope,
        });
      }
    } else {
      to = perFile ? fileKey(row.to) : fnKey(row.to);
    }
    if (!nodes.has(from) || !nodes.has(to)) return;
    edges.push({ key: `c${i}`, from, to, count: row.count, external: row.external, candidate: row.candidate === true });
  });

  const local = [...nodes.values()].filter((n) => n.kind !== "external");
  const links = edges.filter((e) => !e.external).map((e) => ({ from: e.from, to: e.to }));
  const roots = callRoots(
    local.map((n) => n.key),
    links,
    entries,
  );
  return { granularity: flow.granularity, nodes: [...nodes.values()], edges, roots, byKey: nodes };
}

/**
 * The grid a call graph is drawn on. A node sits in the layer of its depth below the roots, so each call
 * points down the page. External callees sit in one last layer under the rest.
 */
export function graphGrid(graph: CallGraph, cols: number = GRID_COLUMNS): Grid {
  const local = graph.nodes.filter((n) => n.kind !== "external");
  const links = graph.edges.filter((e) => !e.external).map((e) => ({ from: e.from, to: e.to }));
  const depth = layerDepths(local.map((n) => n.key), graph.roots, links);
  let last = 0;
  for (const d of depth.values()) last = Math.max(last, d);
  const cells: GridCell[] = graph.nodes.map((n) => ({
    key: n.key,
    layer: n.kind === "external" ? last + 1 : (depth.get(n.key) ?? 0),
    sort: `${n.file ?? ""}\n${n.kind === "module" ? "" : n.name}`,
  }));
  return gridLayout(cells, cols, NODE_CELL);
}

/** One end of a call, seen from a function: the node at the other end and how many calls it stands for. */
export interface CallLink {
  node: GraphNode;
  count: number;
  candidate: boolean;
}

/** The calls a node makes and the calls that reach it, in the graph. An external callee is listed under calls only. */
export function callLinks(graph: CallGraph, key: string): { calls: CallLink[]; calledBy: CallLink[] } {
  const calls: CallLink[] = [];
  const calledBy: CallLink[] = [];
  for (const e of graph.edges) {
    if (e.from === key) {
      const node = graph.byKey.get(e.to);
      if (node) calls.push({ node, count: e.count, candidate: e.candidate });
    }
    if (e.to === key && !e.external) {
      const node = graph.byKey.get(e.from);
      if (node) calledBy.push({ node, count: e.count, candidate: e.candidate });
    }
  }
  return { calls, calledBy };
}

/** A step of a chart that calls a function outside the scope: the step, the callee and the scope that resolves it. */
export interface OutsideStep {
  node: FlowNode;
  target: string;
  name: string;
  file: string;
  scope: string;
}

/** The unresolved steps of one function's chart. */
export function outsideSteps(fn: FunctionFlow, scope: string): OutsideStep[] {
  const out: OutsideStep[] = [];
  for (const node of fn.nodes) {
    const target = node.target;
    if (target === undefined || !outsideScope(target, scope)) continue;
    out.push({ node, target, name: nameOfId(target), ...outsideCall(target, scope) });
  }
  return out;
}
