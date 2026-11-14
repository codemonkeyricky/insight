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
  edge: CallerEdge;
  type: "node" | "cycle";
  expandable: boolean;
  expanded: boolean;
  alsoVia: number;
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

/** The shared walk of visibleRows and expandAllKeys: the edges that show as rows, and whether a node has rows under it. */
function chainOf(g: CallerGraph, opts: { lambdas: boolean }) {
  const kids = childEdges(g);
  const byId = new Map<string, CallerNode>(g.nodes.map((n) => [n.id, n]));
  const fromCount = new Map<string, number>();
  for (const e of g.edges) fromCount.set(e.from, (fromCount.get(e.from) ?? 0) + 1);
  const shown = (n: CallerNode | undefined): n is CallerNode => n !== undefined && (opts.lambdas || !n.name.startsWith("λ"));
  // The edges into a node whose callers show as rows (lambdas folded away when asked).
  const rowsUnder = (id: string): CallerEdge[] => (kids.get(id) ?? []).filter((e) => shown(byId.get(e.from)));
  // Rows under a node: its shown callers, then the "+N more" row when a cap hid some.
  const childCount = (node: CallerNode): number => rowsUnder(node.id).length + ((node.hidden ?? 0) > 0 ? 1 : 0);
  // A node opens when it has rows under it. A node cut by a cap has its hidden callers under it, so it opens too.
  const expandable = (node: CallerNode, cycle: boolean): boolean => !cycle && childCount(node) > 0;
  return { byId, fromCount, rowsUnder, childCount, expandable };
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
 * node ids from the root's first caller down to it, so one node reached by two paths is two rows. A row is a cycle when its
 * node is already on its path or is the root; a cycle never expands. Only expanded rows show their callers.
 */
export function visibleRows(g: CallerGraph, expanded: ReadonlySet<string>, opts: { lambdas: boolean }): Row[] {
  const { byId, fromCount, rowsUnder, expandable } = chainOf(g, opts);
  const out: Row[] = [];
  const emit = (parentId: string, parentKey: string | undefined, level: number, ancestors: ReadonlySet<string>): void => {
    for (const e of rowsUnder(parentId)) {
      const node = byId.get(e.from);
      if (!node) continue;
      const key = parentKey === undefined ? node.id : parentKey + SEP + node.id;
      const cycle = node.id === g.root || ancestors.has(node.id);
      const open = expandable(node, cycle) && expanded.has(key);
      out.push({
        key,
        nodeId: node.id,
        level,
        ...(parentKey !== undefined ? { parentKey } : {}),
        node,
        edge: e,
        type: cycle ? "cycle" : "node",
        expandable: expandable(node, cycle),
        expanded: open,
        alsoVia: Math.max(0, (fromCount.get(node.id) ?? 0) - 1),
      });
      if (open) {
        emit(node.id, key, level + 1, new Set([...ancestors, node.id]));
        if ((node.hidden ?? 0) > 0) out.push(moreRow(key, level + 1, node));
      }
    }
  };
  emit(g.root, undefined, 1, new Set());
  const root = byId.get(g.root);
  if (root && (root.hidden ?? 0) > 0) out.push(moreRow("", 1, root));
  return out;
}

/**
 * The keys to expand so that every row down to maxLevel shows, in depth-first order. A node already expanded on an earlier
 * path is not expanded again, which keeps the walk linear in the nodes. Expansion stops once the visible rows would pass
 * cap; capped says so.
 */
export function expandAllKeys(g: CallerGraph, maxLevel: number, opts: { lambdas: boolean }, cap = 500): { keys: Set<string>; capped: boolean } {
  const { byId, rowsUnder, childCount, expandable } = chainOf(g, opts);
  const keys = new Set<string>();
  const expandedIds = new Set<string>();
  const root = byId.get(g.root);
  let count = rowsUnder(g.root).length + (root && (root.hidden ?? 0) > 0 ? 1 : 0);
  if (count > cap) return { keys, capped: true };
  let capped = false;

  const visit = (parentId: string, parentKey: string | undefined, level: number, ancestors: ReadonlySet<string>): boolean => {
    for (const e of rowsUnder(parentId)) {
      const node = byId.get(e.from);
      if (!node) continue;
      const cycle = node.id === g.root || ancestors.has(node.id);
      if (cycle || level >= maxLevel || !expandable(node, cycle) || expandedIds.has(node.id)) continue;
      const add = childCount(node);
      if (count + add > cap) {
        capped = true;
        return false;
      }
      const key = parentKey === undefined ? node.id : parentKey + SEP + node.id;
      keys.add(key);
      expandedIds.add(node.id);
      count += add;
      if (!visit(node.id, key, level + 1, new Set([...ancestors, node.id]))) return false;
    }
    return true;
  };
  visit(g.root, undefined, 1, new Set());
  return { keys, capped };
}

const KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", "*"]);

/** The keys the tree answers to, for a keydown handler to pass on. */
export function isTreeKey(key: string): boolean {
  return KEYS.has(key);
}

/**
 * WAI-ARIA tree keys over the visible rows. Undefined focus means the first row. Enter names the row to open in `open`
 * (node rows only). An unknown key returns the state unchanged.
 */
export function treeKey(
  rows: Row[],
  state: { focus?: string; expanded: ReadonlySet<string> },
  key: string,
): { focus?: string; expanded: Set<string>; open?: string } {
  const expanded = new Set(state.expanded);
  if (!KEYS.has(key) || rows.length === 0) return { ...(state.focus !== undefined ? { focus: state.focus } : {}), expanded };
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
  const complete = blind === 0 && !g.truncated && (possibleOn || possible === 0);
  if (complete) return { complete: true, text: "Complete within the index." };
  let text = "Exact within the index.";
  if (blind > 0) {
    text += ` ${blind} function(s) on this chain are passed as values or dispatched through a truncated interface set, so they may also run from places the index cannot follow.`;
  }
  if (!possibleOn && possible > 0) {
    text += ` ${possible} possible caller(s) are listed but not followed; turn on Possible callers to follow them.`;
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
