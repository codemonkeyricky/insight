import type { FunctionFacts, Item } from "./build.js";
import type { FlowEdge, FlowEdgeKind, FlowEdgeStyle, FlowNode, FlowShape, FlowRole, FlowSpan, FlowStats, FunctionFlow } from "./types.js";
import { displayName } from "./names.js";

/*
 * The line map: one row per step on a vertical line, a station mark on it, the label to its right. Nesting is the lane
 * (x position of the line). Rows are placed by one recursive walk; edges are made when the next row is known.
 */
export const ROW_H = 30;
export const LANE_W = 24;
/** x of lane 0's line. */
export const LINE_X0 = 22;
export const LABEL_GAP = 18;
export const CHAR_W = 7.2;
/** Longest label in characters; longer ones are clipped with an ellipsis (the full text stays in the title). */
export const LABEL_MAX = 48;
/** Extra space under a loop. */
export const LOOP_GAP = 10;
export const CHART_PAD_R = 16;
/** A function with more nodes than this is not charted; the picture would not help. */
export const MAX_NODES = 700;

/** A call step drawn as a band: its header is one row. */
export const NEST_HEAD = ROW_H;
export const NEST_TOP = 0;
export const NEST_PAD = 0;

/** Centre of a node's station: its lane's line, at the middle of its row (a nest's header row). */
export function stationOf(node: FlowNode): [number, number] {
  return [LINE_X0 + (node.lane ?? 0) * LANE_W, node.y + ROW_H / 2];
}

/** A callee drawn inside the call step that calls it. `inline` holds the calls nested inside it, by the ids of its steps. */
export interface InlineEntry {
  flow: FunctionFlow;
  inline?: InlineTree;
}

/** The call steps drawn expanded, by the step's id in its own chart. A step nested inside a frame is drawn with the frame's id, a slash, and that id. */
export type InlineTree = ReadonlyMap<string, InlineEntry>;

interface Scope {
  /** Nodes laid out so far across the whole chart, against MAX_NODES. */
  budget: { used: number };
  /** The functions whose charts enclose this one: a callee in the list is never nested again. */
  ancestors: ReadonlySet<string>;
}

class Maker {
  private n = 0;
  constructor(
    readonly prefix = "",
    readonly inline: InlineTree | undefined = undefined,
    readonly base: ReadonlyMap<string, FlowNode> | undefined = undefined,
    readonly scope: Scope = { budget: { used: 0 }, ancestors: new Set() },
  ) {}
  /** Takes an id without making a node: where a join used to be made, and a nested chart's start terminator, so ids stay stable. */
  reserve(): void {
    this.n++;
  }
  node(role: FlowRole, shape: FlowShape, label: string, extra: { title?: string; span?: FlowSpan; target?: string; handler?: true } = {}): FlowNode {
    return this.make(`${this.prefix}n${++this.n}`, role, shape, label, extra);
  }
  make(id: string, role: FlowRole, shape: FlowShape, label: string, extra: { title?: string; span?: FlowSpan; target?: string; handler?: true } = {}): FlowNode {
    const out: FlowNode = { id, role, shape, label, w: 0, h: ROW_H, x: 0, y: 0 };
    if (extra.title !== undefined && extra.title !== label) out.title = extra.title;
    if (extra.span) out.span = extra.span;
    if (extra.target) out.target = extra.target;
    if (extra.handler) out.handler = true;
    return out;
  }
}

/** Where control leaves a row, waiting for the row that follows. `trunk` is the lane of a fork's trunk the line returns to. */
interface Pend {
  from: FlowNode;
  kind: FlowEdgeKind;
  style: FlowEdgeStyle;
  trunk?: number;
}

/** What the walk builds. */
interface Ctx {
  y: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Tag for the next row placed. */
  tag?: string;
}

type Pt = [number, number];

/** Path data and vertices for a line from (xa, ya) to (xb, yb). `trunkX` makes it curve onto a trunk in the row below the source first. */
function route(xa: number, ya: number, xb: number, yb: number, trunkX?: number): { d: string; points: Pt[] } {
  const points: Pt[] = [[xa, ya]];
  let d = `M${xa} ${ya}`;
  let x = xa;
  let y = ya;
  if (trunkX !== undefined && Math.abs(trunkX - xa) > 0.5 && yb - ya >= ROW_H) {
    const h = ROW_H;
    d += `C${x} ${y + h * 0.3} ${trunkX} ${y + h * 0.7} ${trunkX} ${y + h}`;
    x = trunkX;
    y += h;
    points.push([x, y]);
  }
  if (Math.abs(x - xb) < 0.5) {
    d += `L${xb} ${yb}`;
    points.push([xb, yb]);
    return { d, points };
  }
  const h = Math.max(0, Math.min(ROW_H, yb - y));
  if (xb > x) {
    if (yb - y > h) {
      d += `L${x} ${yb - h}`;
      points.push([x, yb - h]);
    }
    const y0 = yb - h;
    d += `C${x} ${y0 + h * 0.7} ${xb} ${y0 + h * 0.3} ${xb} ${y0 + h}L${xb} ${yb}`;
  } else {
    d += `L${x} ${yb - h}C${x} ${yb - h * 0.3} ${xb} ${yb - h * 0.7} ${xb} ${yb}`;
    points.push([x, yb - h]);
  }
  points.push([xb, yb]);
  return { d, points };
}

function link(c: Ctx, p: Pend, to: FlowNode): void {
  const [xa, ya] = stationOf(p.from);
  const [xb, yb] = stationOf(to);
  const la = p.from.lane ?? 0;
  const lb = to.lane ?? 0;
  const lane = p.style === "skip" || p.style === "done" ? la : Math.max(la, lb);
  const r = route(xa, ya, xb, yb, p.trunk === undefined ? undefined : LINE_X0 + p.trunk * LANE_W);
  c.edges.push({ from: p.from.id, to: to.id, kind: p.kind, style: p.style, lane, d: r.d, points: r.points });
}

/** The loop's back edge: down from the turn, into the gutter right of the head's line, up, and pointing at the head. */
function backEdge(c: Ctx, turn: FlowNode, head: FlowNode): void {
  const [xa, ya] = stationOf(turn);
  const [xb, yb] = stationOf(head);
  const bx = xb + LANE_W / 2;
  const H = ROW_H;
  const d = `M${xa} ${ya}C${xa} ${ya + H * 0.9} ${bx} ${ya + H * 0.9} ${bx} ${ya}L${bx} ${yb + H * 0.85}Q${bx} ${yb + H * 0.3} ${xb + 8} ${yb + 5}`;
  c.edges.push({ from: turn.id, to: head.id, kind: "back", style: "back", lane: turn.lane ?? 0, d, points: [[xa, ya], [bx, ya], [bx, yb + H * 0.85], [xb + 8, yb + 5]] });
}

/** Puts a node on the next row and links what was waiting for it. */
function row(c: Ctx, node: FlowNode, lane: number, labelLane: number, skip: number, into: Pend[]): void {
  node.lane = lane;
  node.y = c.y;
  node.h = ROW_H;
  c.y += ROW_H;
  node.labelX = LINE_X0 + Math.max(labelLane, lane + skip) * LANE_W + LABEL_GAP;
  if (c.tag !== undefined) {
    node.tag = c.tag;
    c.tag = undefined;
  }
  c.nodes.push(node);
  for (const p of into) link(c, p, node);
}

const next = (from: FlowNode): Pend => ({ from, kind: "next", style: "solid" });

function clipLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function walkList(c: Ctx, mk: Maker, items: Item[], lane: number, labelLane: number, skip: number, into: Pend[]): Pend[] {
  let cur = into;
  for (const it of items) cur = walkItem(c, mk, it, lane, labelLane, skip, cur);
  return cur;
}

function walkItem(c: Ctx, mk: Maker, item: Item, lane: number, labelLane: number, skip: number, into: Pend[]): Pend[] {
  switch (item.t) {
    case "step": {
      if (item.role === "marker") {
        const m = mk.node("marker", "label", item.label, item.span ? { span: item.span } : {});
        row(c, m, lane, labelLane, skip, into);
        return [next(m)];
      }
      const node = mk.node(item.role, "step", clipLabel(item.label, LABEL_MAX), { title: item.title ?? item.label, ...(item.span ? { span: item.span } : {}), ...(item.target ? { target: item.target } : {}), ...(item.handler ? { handler: true as const } : {}) });
      return stepRow(c, mk, node, lane, labelLane, skip, into);
    }
    case "term": {
      const t = mk.node(item.role, "exit", item.label, item.span ? { span: item.span } : {});
      row(c, t, lane, labelLane, skip, into);
      return [];
    }
    case "fork":
      return fork(c, mk, item, lane, labelLane, skip, into);
    case "loop":
      return loop(c, mk, item, lane, labelLane, skip, into);
  }
}

const tagFor = (label: string): string => (label === "else" || label === "no" ? "else" : label);

function fork(c: Ctx, mk: Maker, item: Extract<Item, { t: "fork" }>, lane: number, labelLane: number, skip: number, into: Pend[]): Pend[] {
  const head =
    item.role === "try"
      ? mk.node("marker", "label", "try", item.span ? { span: item.span } : {})
      : mk.node(item.role, "decision", clipLabel(item.role === "switch" ? "switch" : item.label, LABEL_MAX), { title: item.title ?? item.label, ...(item.span ? { span: item.span } : {}) });
  row(c, head, lane, labelLane, skip, into);
  const inner = lane + 1 + skip;
  const out: Pend[] = [];
  let falls = !item.complete || item.arms.some((a) => a.body.length === 0);
  if (item.role === "branch") {
    const t = item.arms.find((a) => a.kind === "true");
    const f = item.arms.find((a) => a.kind === "false");
    const tBody = t?.body ?? [];
    const fBody = f?.body ?? [];
    const tOut = tBody.length > 0 ? walkList(c, mk, tBody, inner, labelLane, 0, [{ from: head, kind: "true", style: "solid" }]) : [];
    // The true arm's merge line runs down its lane beside the false arm's rows, so those step one lane right.
    const tFalls = tOut.length > 0;
    let fOut: Pend[] = [];
    if (fBody.length > 0) {
      c.tag = tagFor(f?.label ?? "else");
      fOut = walkList(c, mk, fBody, lane, labelLane, tFalls ? skip + 1 : skip, [{ from: head, kind: "false", style: "solid" }]);
    }
    out.push(...tOut, ...fOut);
    if (fBody.length === 0) out.push({ from: head, kind: "false", style: "skip" });
    else if (tBody.length === 0) out.push({ from: head, kind: "true", style: "skip" });
    falls = falls || tOut.length > 0 || fOut.length > 0;
  } else {
    // Trunk and sidings: every arm's rows on the inner lane, one arm after another.
    let any = !item.complete;
    for (const a of item.arms) {
      if (a.body.length === 0) {
        any = true;
        continue;
      }
      if (a.kind === "exception") c.tag = "catch";
      else if (a.kind !== "next") c.tag = a.label;
      const o = walkList(c, mk, a.body, inner, labelLane, 0, [{ from: head, kind: a.kind, style: a.kind === "exception" ? "throws" : "solid" }]);
      if (o.length > 0) {
        any = true;
        for (const p of o) p.trunk = lane;
        out.push(...o);
      }
    }
    if (any) out.push(next(head));
    falls = falls || any;
  }
  // The id a join used to take.
  if (falls) mk.reserve();
  return out;
}

function loop(c: Ctx, mk: Maker, item: Extract<Item, { t: "loop" }>, lane: number, labelLane: number, skip: number, into: Pend[]): Pend[] {
  const head = mk.node("loop", "loop", clipLabel(item.label, LABEL_MAX), { title: item.title ?? item.label, ...(item.span ? { span: item.span } : {}) });
  row(c, head, lane, labelLane, skip, into);
  const inner = lane + 1 + skip;
  const body = item.body.length > 0 ? walkList(c, mk, item.body, inner, labelLane, 0, [{ from: head, kind: "each", style: "solid" }]) : [];
  if (body.length > 0) {
    const turn = mk.make(`${head.id}t`, "marker", "turn", "next");
    row(c, turn, inner, labelLane, 0, body);
    backEdge(c, turn, head);
  }
  c.y += LOOP_GAP;
  // The id a join used to take.
  mk.reserve();
  return [{ from: head, kind: "exit", style: "done" }];
}

/** A step, taking the target a viewer gave the chart it was built from, and nested when its callee is expanded. */
function stepRow(c: Ctx, mk: Maker, node: FlowNode, lane: number, labelLane: number, skip: number, into: Pend[]): Pend[] {
  const local = node.id.slice(mk.prefix.length);
  const b = mk.base?.get(local);
  if (b !== undefined) {
    node.label = b.label;
    if (b.title !== undefined) node.title = b.title;
    else delete node.title;
    if (b.target !== undefined) node.target = b.target;
    else delete node.target;
    if (b.handler) node.handler = true;
    else delete node.handler;
  }
  const entry = mk.inline?.get(local);
  const nested = entry !== undefined ? nest(c, mk, node, entry, lane, labelLane, skip, into) : undefined;
  if (nested !== undefined) return nested;
  row(c, node, lane, labelLane, skip, into);
  return [next(node)];
}

/**
 * A call step with its callee's rows under it: the step's own node, now shaped "nest" (a band), is the header row and the
 * callee's rows sit on the next lane. Undefined when the callee cannot be nested (no pre-layout chart, a function already
 * in the chain, or the chart would pass MAX_NODES), and the step stays a plain step.
 */
function nest(c: Ctx, mk: Maker, node: FlowNode, entry: InlineEntry, lane: number, labelLane: number, skip: number, into: Pend[]): Pend[] | undefined {
  const flow = entry.flow;
  const { scope } = mk;
  if (flow.items === undefined || flow.tooLarge || scope.ancestors.has(flow.id)) return undefined;
  const add = countNodes(flow.items) + 1;
  if (scope.budget.used + add > MAX_NODES) return undefined;
  scope.budget.used += add;
  const sub = new Maker(`${node.id}/`, entry.inline, new Map(flow.nodes.map((n) => [n.id, n])), { budget: scope.budget, ancestors: new Set([...scope.ancestors, flow.id]) });
  sub.reserve();
  node.shape = "nest";
  node.label = clipLabel(displayName(flow.name, flow.id), LABEL_MAX);
  node.title = flow.name;
  row(c, node, lane, labelLane, skip, into);
  const first = c.nodes.length - 1;
  const out = walkList(c, sub, flow.items, lane + 1 + skip, labelLane, 0, [next(node)]);
  let bottom = node.y + ROW_H;
  for (let i = first; i < c.nodes.length; i++) bottom = Math.max(bottom, (c.nodes[i] as FlowNode).y + (c.nodes[i] as FlowNode).h);
  node.h = bottom - node.y;
  // A callee that always returns or throws does not end the caller's line: it goes on from the header.
  return out.length === 0 ? [next(node)] : out;
}

function countNodes(items: Item[]): number {
  let n = 0;
  for (const i of items) {
    n += 1;
    if (i.t === "fork") for (const a of i.arms) n += 1 + countNodes(a.body);
    else if (i.t === "loop") n += 1 + countNodes(i.body);
  }
  return n;
}

export function measure(items: Item[]): FlowStats {
  const s: FlowStats = { steps: 0, decisions: 0, loops: 0, tries: 0, exits: 0, depth: 0 };
  const walk = (list: Item[], depth: number) => {
    s.depth = Math.max(s.depth, depth);
    for (const i of list) {
      if (i.t === "step") {
        if (i.role !== "marker") s.steps++;
      } else if (i.t === "term") s.exits++;
      else if (i.t === "loop") {
        s.loops++;
        walk(i.body, depth + 1);
      } else {
        if (i.role === "try") s.tries++;
        else s.decisions++;
        for (const a of i.arms) walk(a.body, depth + 1);
      }
    }
  };
  walk(items, 0);
  return s;
}

/** Lay out one function as a line map: rows on lanes. */
export function layoutFunction(fn: FunctionFacts, opts: { inline?: InlineTree; base?: FunctionFlow } = {}): FunctionFlow {
  const stats = measure(fn.items);
  const base = { id: fn.id, name: fn.name, async: fn.async, ...(fn.span ? { span: fn.span } : {}), stats };
  const count = countNodes(fn.items);
  if (count > MAX_NODES) return { ...base, tooLarge: true, width: 0, height: 0, nodes: [], edges: [] };
  const mk = new Maker("", opts.inline, opts.base === undefined ? undefined : new Map(opts.base.nodes.map((n) => [n.id, n])), { budget: { used: count }, ancestors: new Set([fn.id]) });
  const c: Ctx = { y: 0, nodes: [], edges: [] };
  const start = mk.node("start", "terminator", clipLabel(`${fn.async ? "async " : ""}${displayName(fn.name, fn.id)}`, LABEL_MAX), { title: fn.name, ...(fn.span ? { span: fn.span } : {}) });
  row(c, start, 0, 0, 0, []);
  const out = walkList(c, mk, fn.items, 0, 0, 0, [next(start)]);
  if (fn.items.length === 0 || out.length > 0) row(c, mk.node("end", "terminator", "end"), 0, 0, 0, out);
  // Sizes, once every label and lane is known.
  let right = 0;
  let bottom = 0;
  for (const n of c.nodes) {
    const textW = CHAR_W * (n.label.length + (n.tag?.length ?? 0) + 6);
    n.x = LINE_X0 + (n.lane ?? 0) * LANE_W - (n.shape === "nest" ? 13 : 10);
    n.w = (n.labelX ?? 0) - n.x + textW + 8;
    right = Math.max(right, (n.labelX ?? 0) + textW);
    bottom = Math.max(bottom, n.y + n.h);
  }
  const width = Math.max(260, right + CHART_PAD_R);
  for (const n of c.nodes) if (n.shape === "nest") n.w = width - 4 - n.x;
  return { ...base, width, height: bottom + 8, nodes: c.nodes, edges: c.edges, ...(opts.inline === undefined ? { items: fn.items } : {}) };
}

/**
 * The chart laid out again with the callees of `inline` nested in their call steps. A chart without its pre-layout items
 * (too large to draw) is returned as it is. Nodes outside any frame keep their ids, and a nested node's id starts with
 * its frame's, so a viewer can tell a step's depth from its id. The returned chart carries the same items.
 */
export function relayout(flow: FunctionFlow, inline: InlineTree): FunctionFlow {
  if (flow.items === undefined || flow.tooLarge || inline.size === 0) return flow;
  const out = layoutFunction({ id: flow.id, name: flow.name, async: flow.async, ...(flow.span ? { span: flow.span } : {}), items: flow.items }, { inline, base: flow });
  return { ...out, items: flow.items };
}
