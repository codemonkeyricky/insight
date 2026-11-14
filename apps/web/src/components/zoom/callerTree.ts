// The caller chain as a flat list of rows, in depth-first order, and the keyboard model of its ARIA tree. Pure: no React,
// so the chain can be tested without a DOM. The rows come from a CallerGraph (see callerGraph in @insight/model).
import type { CallerEdge, CallerGraph, CallerNode } from "@insight/model";

/** Joins the node ids of a row's path into its key. A node id never holds this character. */
const SEP = "\u0001";
/** Separates a row's key from the "+N more" row that follows it. */
const MORE = "\u0002more";

export interface TreeRow {
  key: string;
  nodeId: string;
  level: number;
  parentKey?: string;
  node: CallerNode;
  /** Every edge from this caller into the row above it: one row per caller, however many edges join them. */
  edges: CallerEdge[];
  /** The first of edges, for code that wants a single edge. */
  edge: CallerEdge;
  type: "node" | "cycle";
  expandable: boolean;
  expanded: boolean;
  /** The distinct callees this caller reaches, less one: how many other paths show it. */
  alsoVia: number;
  /** This row's place among its siblings (the rows under the same parent), counted from 1. */
  posinset: number;
  setsize: number;
}

export interface MoreRow {
  key: string;
  level: number;
  parentKey: string;
  type: "more";
  count: number;
  reason: "depth" | "nodes";
}

export type Row = TreeRow | MoreRow;

/** The callers of each node: the edges grouped by their callee, in graph order. */
export function childEdges(g: CallerGraph): Map<string, CallerEdge[]> {
  const map = new Map<string, CallerEdge[]>();
  for (const e of g.edges) {
    const list = map.get(e.to);
    if (list) list.push(e);
    else map.set(e.to, [e]);
  }
  return map;
}

/** One caller of a node: the caller and every edge from it into that node. */
interface Caller {
  node: CallerNode;
  edges: CallerEdge[];
}

/** The shared walk of visibleRows and expandAllKeys: the callers that show as rows, and whether a node has rows under it. */
function chainOf(g: CallerGraph, opts: { lambdas: boolean }) {
  const kids = childEdges(g);
  const byId = new Map<string, CallerNode>(g.nodes.map((n) => [n.id, n]));
  // The distinct callees of each caller: a caller that reaches two of them is shown by two paths.
  const callees = new Map<string, Set<string>>();
  for (const e of g.edges) {
    const set = callees.get(e.from);
    if (set) set.add(e.to);
    else callees.set(e.from, new Set([e.to]));
  }
  const shown = (n: CallerNode | undefined): n is CallerNode => n !== undefined && (opts.lambdas || !n.name.startsWith("λ"));
  // The callers of a node whose callers show as rows (lambdas folded away when asked): one entry per caller, in graph order.
  const rowsUnder = (id: string): Caller[] => {
    const byCaller = new Map<string, Caller>();
    for (const e of kids.get(id) ?? []) {
      const node = byId.get(e.from);
      if (!shown(node)) continue;
      const found = byCaller.get(e.from);
      if (found) found.edges.push(e);
      else byCaller.set(e.from, { node, edges: [e] });
    }
    return [...byCaller.values()];
  };
  // Rows under a node: its shown callers, then the "+N more" row when a cap hid some.
  const childCount = (node: CallerNode): number => rowsUnder(node.id).length + ((node.hidden ?? 0) > 0 ? 1 : 0);
  // A node opens when it has rows under it. A node cut by a cap has its hidden callers under it, so it opens too.
  const expandable = (node: CallerNode, cycle: boolean): boolean => !cycle && childCount(node) > 0;
  const alsoVia = (id: string): number => Math.max(0, (callees.get(id)?.size ?? 0) - 1);
  return { alsoVia, rowsUnder, childCount, expandable };
}

function moreRow(parentKey: string, level: number, node: CallerNode): MoreRow {
  return {
    key: parentKey + MORE,
    level,
    parentKey,
    type: "more",
    count: node.hidden ?? 0,
    reason: node.stop === "depth" ? "depth" : "nodes",
  };
}

/**
 * The rows the chain shows, depth first. The root is not a row: level-1 rows are its callers. A row's key is the path of
 * node ids from the root's first caller down to it, so one node reached by two paths is two rows. A caller with several
 * edges into the same callee is one row carrying all of them. A row is a cycle when its node is already on its path or is
 * the root; a cycle never expands. Only expanded rows show their callers.
 */
export function visibleRows(g: CallerGraph, expanded: ReadonlySet<string>, opts: { lambdas: boolean }): Row[] {
  const { alsoVia, rowsUnder, expandable } = chainOf(g, opts);
  const out: Row[] = [];
  const emit = (parentId: string, parentKey: string | undefined, level: number, ancestors: ReadonlySet<string>): void => {
    const callers = rowsUnder(parentId);
    callers.forEach(({ node, edges }, i) => {
      const key = parentKey === undefined ? node.id : parentKey + SEP + node.id;
      const cycle = node.id === g.root || ancestors.has(node.id);
      const open = expandable(node, cycle) && expanded.has(key);
      out.push({
        key,
        nodeId: node.id,
        level,
        ...(parentKey !== undefined ? { parentKey } : {}),
        node,
        edges,
        edge: edges[0] as CallerEdge,
        type: cycle ? "cycle" : "node",
        expandable: expandable(node, cycle),
        expanded: open,
        alsoVia: alsoVia(node.id),
        posinset: i + 1,
        setsize: callers.length,
      });
      if (open) {
        emit(node.id, key, level + 1, new Set([...ancestors, node.id]));
        if ((node.hidden ?? 0) > 0) out.push(moreRow(key, level + 1, node));
      }
    });
  };
  emit(g.root, undefined, 1, new Set());
  const root = rootNode(g);
  if (root && (root.hidden ?? 0) > 0) out.push(moreRow("", 1, root));
  return out;
}

const rootNode = (g: CallerGraph): CallerNode | undefined => g.nodes.find((n) => n.id === g.root);

/**
 * The keys to expand so that every row down to maxLevel shows, walking breadth first, level by level. Each node is expanded
 * at its shallowest occurrence (the first one breadth-first meets), so a caller reached by a shorter path is never hidden
 * by a deeper occurrence on a longer one. A node is expanded at most once, which keeps the walk linear in the nodes.
 * Expansion stops once the visible rows would pass cap; capped says so.
 */
export function expandAllKeys(g: CallerGraph, maxLevel: number, opts: { lambdas: boolean }, cap = 500): { keys: Set<string>; capped: boolean } {
  const { rowsUnder, childCount, expandable } = chainOf(g, opts);
  const keys = new Set<string>();
  const expandedIds = new Set<string>();
  const root = rootNode(g);
  let count = rowsUnder(g.root).length + (root && (root.hidden ?? 0) > 0 ? 1 : 0);
  if (count > cap) return { keys, capped: true };
  let capped = false;

  // A queue of rows, each with its key, level and the node ids on its path. Rows are appended as their parents expand, so the
  // queue is in breadth-first order and the first time a node is dequeued is its shallowest occurrence.
  type Item = { node: CallerNode; key: string; level: number; ancestors: ReadonlySet<string> };
  const queue: Item[] = rowsUnder(g.root).map(({ node }) => ({ node, key: node.id, level: 1, ancestors: new Set<string>() }));

  for (let i = 0; i < queue.length; i++) {
    const { node, key, level, ancestors } = queue[i] as Item;
    const cycle = node.id === g.root || ancestors.has(node.id);
    if (cycle || level >= maxLevel || !expandable(node, cycle) || expandedIds.has(node.id)) continue;
    const add = childCount(node);
    if (count + add > cap) {
      capped = true;
      return { keys, capped };
    }
    keys.add(key);
    expandedIds.add(node.id);
    count += add;
    const childAncestors = new Set([...ancestors, node.id]);
    for (const c of rowsUnder(node.id)) {
      queue.push({ node: c.node, key: key + SEP + c.node.id, level: level + 1, ancestors: childAncestors });
    }
  }
  return { keys, capped };
}

const KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", "*"]);

/** The keys the tree answers to, for a keydown handler to pass on. */
export function isTreeKey(key: string): boolean {
  return KEYS.has(key);
}

/**
 * The tree key a keydown event names, or undefined when the tree does not answer it. A key pressed with Alt, Ctrl or Meta
 * is left to the browser and to the page's shortcuts, so it is not a tree key.
 */
export function treeKeyOf(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): string | undefined {
  if (e.altKey || e.ctrlKey || e.metaKey) return undefined;
  return isTreeKey(e.key) ? e.key : undefined;
}

/**
 * The focus after a row is collapsed: a focus inside the collapsed row's subtree is no longer visible, so it moves to the row.
 * Any other focus stays.
 */
export function focusAfterCollapse(focus: string | undefined, key: string): string | undefined {
  if (focus === undefined) return undefined;
  return focus === key || focus.startsWith(key + SEP) ? key : focus;
}

/**
 * WAI-ARIA tree keys over the visible rows. Undefined focus, or a focus that names no visible row, means the first row.
 * Enter names the row to open in `open` (node rows only). An unknown key returns the state unchanged.
 */
export function treeKey(
  rows: Row[],
  state: { focus?: string; expanded: ReadonlySet<string> },
  key: string,
): { focus?: string; expanded: Set<string>; open?: string } {
  const expanded = new Set(state.expanded);
  if (!KEYS.has(key) || rows.length === 0) return { ...(state.focus !== undefined ? { focus: state.focus } : {}), expanded };
  // An unknown focus is the first row: findIndex gives -1, which clamps to 0.
  const at = Math.max(0, rows.findIndex((r) => r.key === state.focus));
  const cur = rows[at] as Row;
  const last = rows.length - 1;
  const to = (i: number) => ({ focus: (rows[i] as Row).key, expanded });

  switch (key) {
    case "ArrowDown":
      return to(Math.min(at + 1, last));
    case "ArrowUp":
      return to(Math.max(at - 1, 0));
    case "Home":
      return to(0);
    case "End":
      return to(last);
    case "ArrowRight": {
      if (cur.type !== "node" || !cur.expandable) return to(at);
      if (!cur.expanded) {
        expanded.add(cur.key);
        return { focus: cur.key, expanded };
      }
      const child = rows.find((r) => r.parentKey === cur.key);
      return { focus: child?.key ?? cur.key, expanded };
    }
    case "ArrowLeft": {
      if (cur.type === "node" && cur.expanded) {
        expanded.delete(cur.key);
        return { focus: cur.key, expanded };
      }
      const parent = cur.parentKey !== undefined ? rows.find((r) => r.key === cur.parentKey) : undefined;
      return { focus: parent?.key ?? cur.key, expanded };
    }
    case "Enter":
      return cur.type === "node" ? { focus: cur.key, expanded, open: cur.key } : { focus: cur.key, expanded };
    case "*": {
      if (cur.type === "node") {
        for (const r of rows) {
          if (r.type === "node" && r.expandable && r.parentKey === cur.parentKey && r.level === cur.level) expanded.add(r.key);
        }
      }
      return { focus: cur.key, expanded };
    }
    default:
      return to(at);
  }
}

/** The one-line count of the chain, for the summary above the tree. */
export function summaryLine(g: CallerGraph): string {
  const { callers, levels, possible } = g.stats;
  if (callers === 0) return "No callers in the project.";
  let text = `${callers} caller${callers === 1 ? "" : "s"} across ${levels} level${levels === 1 ? "" : "s"}`;
  if (possible > 0) text += ` · ${possible} possible`;
  if (g.truncated?.reason === "nodes") text += ` · capped at ${g.truncated.at} nodes`;
  else if (g.truncated?.reason === "depth") text += ` · capped at depth ${g.truncated.at}`;
  return text;
}

/** Whether the chain is complete within the index, and the note that says what it leaves out. */
export function completeness(g: CallerGraph, possibleOn: boolean): { complete: boolean; text: string } {
  const { blind, possible } = g.stats;
  // The callers Stay in scope stopped at the scope's edge: listed, but the walk did not go on past them.
  const outside = g.nodes.filter((n) => n.stop === "outside-scope").length;
  const complete = blind === 0 && !g.truncated && (possibleOn || possible === 0) && outside === 0;
  if (complete) return { complete: true, text: "Complete within the index." };
  let text = "Exact within the index.";
  if (blind > 0) {
    text += ` ${blind} function(s) on this chain are passed as values or dispatched through a truncated interface set, so they may also run from places the index cannot follow.`;
  }
  if (!possibleOn && possible > 0) {
    text += ` ${possible} possible caller(s) are listed but not followed; turn on Possible callers to follow them.`;
  }
  if (outside > 0) {
    text += ` ${outside} caller(s) outside the scope are listed but not followed; turn off Stay in scope to follow them.`;
  }
  if (g.truncated) text += " The chain is capped, so some callers are not shown.";
  return { complete: false, text };
}

/** The tip of a blind-spot mark: why the function may run from places the index cannot follow. */
export function blindTip(node: CallerNode, edge?: CallerEdge): string | undefined {
  const parts: string[] = [];
  if (node.blind?.includes("value")) {
    parts.push(
      "Passed as a value" +
        (edge?.site ? ` at ${edge.site.file}:${edge.site.line}` : "") +
        "; it may also run from code the index cannot follow.",
    );
  }
  if (node.blind?.includes("truncated")) {
    parts.push("One of a truncated set of interface targets; it may also run from callers the index cannot list.");
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
