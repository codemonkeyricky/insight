import type { Arm, FunctionFacts, Item } from "./build.js";
import type { FlowEdge, FlowEdgeKind, FlowNode, FlowShape, FlowRole, FlowSpan, FlowStats, FunctionFlow } from "./types.js";

const STEP_W = 236;
const STEP_H = 34;
const DEC_W = 236;
const DEC_H = 54;
const TERM_W = 150;
const TERM_H = 28;
const MARK_W = 110;
const MARK_H = 26;
const JOIN = 10;
const GAP_Y = 26;
const GAP_X = 30;
const MIN_ARM = 64;
const LOOP_PAD = 40;
/*
 * Longest labels that fit their boxes at 12px monospace (about 7.2px a character). A step's
 * rectangle is 236 wide; a diamond's text line is about 180 wide and a hexagon's about 200.
 * The full text stays in the node's title.
 */
const STEP_LABEL = 30;
const DEC_LABEL = 24;
const LOOP_LABEL = 28;
/** A function with more nodes than this is not charted; the picture would not help. */
export const MAX_NODES = 700;

/** A laid-out piece of the chart. Coordinates are relative to its top-left corner. */
interface Frag {
  w: number;
  h: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** First node, which sits at the top centre. Absent for an empty piece. */
  entry?: string;
  /** Last node, at the bottom centre. Absent when control never falls out of the bottom. */
  exit?: string;
}

class Maker {
  private n = 0;
  node(role: FlowRole, shape: FlowShape, label: string, w: number, h: number, extra: { title?: string; span?: FlowSpan; target?: string; handler?: true } = {}): FlowNode {
    const out: FlowNode = { id: `n${++this.n}`, role, shape, label, w, h, x: 0, y: 0 };
    if (extra.title !== undefined && extra.title !== label) out.title = extra.title;
    if (extra.span) out.span = extra.span;
    if (extra.target) out.target = extra.target;
    if (extra.handler) out.handler = true;
    return out;
  }
}

const EMPTY: Frag = { w: 0, h: 0, nodes: [], edges: [] };

function shift(f: Frag, dx: number, dy: number): void {
  for (const n of f.nodes) {
    n.x += dx;
    n.y += dy;
  }
  for (const e of f.edges) {
    e.points = e.points.map(([x, y]) => [x + dx, y + dy]);
    if (e.labelAt) e.labelAt = [e.labelAt[0] + dx, e.labelAt[1] + dy];
  }
}

function single(node: FlowNode, terminal = false): Frag {
  return { w: node.w, h: node.h, nodes: [node], edges: [], entry: node.id, ...(terminal ? {} : { exit: node.id }) };
}

/** Stack pieces top to bottom on one centre line, joining each to the next. */
function stack(frags: Frag[]): Frag {
  const parts = frags.filter((f) => f.entry !== undefined);
  if (parts.length === 0) return EMPTY;
  const w = Math.max(...parts.map((f) => f.w));
  const out: Frag = { w, h: 0, nodes: [], edges: [] };
  let y = 0;
  let prevExit: string | undefined;
  let prevBottom = 0;
  for (const f of parts) {
    shift(f, (w - f.w) / 2, y);
    if (prevExit !== undefined && f.entry !== undefined) {
      out.edges.push({ from: prevExit, to: f.entry, kind: "next", points: [[w / 2, prevBottom], [w / 2, y]] });
    }
    out.nodes.push(...f.nodes);
    out.edges.push(...f.edges);
    if (out.entry === undefined) out.entry = f.entry;
    prevExit = f.exit;
    prevBottom = y + f.h;
    y += f.h + GAP_Y;
  }
  out.h = y - GAP_Y;
  if (prevExit !== undefined) out.exit = prevExit;
  return out;
}

const armLabel = (a: Arm): string => (a.kind === "true" ? "yes" : a.kind === "false" ? (a.label === "else" ? "no" : a.label) : a.kind === "exception" ? "throws" : a.kind === "next" ? "" : a.label);

function fork(mk: Maker, item: Extract<Item, { t: "fork" }>): Frag {
  const isTry = item.role === "try";
  const head = isTry
    ? mk.node("marker", "label", "try", MARK_W, MARK_H, item.span ? { span: item.span } : {})
    : mk.node(item.role, "decision", clipLabel(item.role === "switch" ? "switch" : item.label, DEC_LABEL), DEC_W, DEC_H, { title: item.title ?? item.label, ...(item.span ? { span: item.span } : {}) });
  const arms = item.arms.map((a) => ({ arm: a, frag: stack(a.body.map((i) => piece(mk, i))) }));
  const widths = arms.map((a) => Math.max(a.frag.w, MIN_ARM));
  const total = widths.reduce((s, w) => s + w, 0) + GAP_X * (arms.length - 1);
  const W = Math.max(total, head.w);
  const out: Frag = { w: W, h: 0, nodes: [head], edges: [], entry: head.id };
  head.x = (W - head.w) / 2;
  const cx = W / 2;
  const topBus = head.h + 16;
  const armsTop = topBus + 22;
  const armsH = Math.max(0, ...arms.map((a) => a.frag.h));
  const allTerminal = item.complete && arms.every((a) => a.frag.entry !== undefined && a.frag.exit === undefined);
  const joinBus = armsTop + armsH + 14;
  const joinTop = joinBus + 12;
  const join = allTerminal ? undefined : mk.node("join", "join", "", JOIN, JOIN);
  if (join) {
    join.x = cx - JOIN / 2;
    join.y = joinTop;
    out.nodes.push(join);
  }
  let colX = (W - total) / 2;
  arms.forEach(({ arm, frag }, i) => {
    const colW = widths[i] as number;
    const armCx = colX + colW / 2;
    const kind: FlowEdgeKind = arm.kind;
    const label = armLabel(arm);
    // Above the bus, so the label never sits on the drop into an arm. The halo keeps it legible where the trunk crosses.
    const labelAt: [number, number] = [armCx, topBus - 8];
    if (frag.entry !== undefined) {
      shift(frag, colX + (colW - frag.w) / 2, armsTop);
      out.nodes.push(...frag.nodes);
      out.edges.push(...frag.edges);
      out.edges.push({ from: head.id, to: frag.entry, kind, ...(label ? { label, labelAt } : {}), points: [[cx, head.h], [cx, topBus], [armCx, topBus], [armCx, armsTop]] });
      if (join && frag.exit !== undefined) {
        out.edges.push({ from: frag.exit, to: join.id, kind: "next", points: [[armCx, armsTop + frag.h], [armCx, joinBus], [cx, joinBus], [cx, joinTop]] });
      }
    } else if (join) {
      // An arm with nothing in it goes straight from the decision to the join.
      out.edges.push({ from: head.id, to: join.id, kind, ...(label ? { label, labelAt } : {}), points: [[cx, head.h], [cx, topBus], [armCx, topBus], [armCx, joinBus], [cx, joinBus], [cx, joinTop]] });
    }
    colX += colW + GAP_X;
  });
  if (join) {
    out.h = joinTop + JOIN;
    out.exit = join.id;
  } else {
    out.h = armsTop + armsH;
  }
  return out;
}

function loop(mk: Maker, item: Extract<Item, { t: "loop" }>): Frag {
  const head = mk.node("loop", "loop", clipLabel(item.label, LOOP_LABEL), DEC_W, DEC_H, { title: item.title ?? item.label, ...(item.span ? { span: item.span } : {}) });
  const body = stack(item.body.map((i) => piece(mk, i)));
  const W = Math.max(body.w, DEC_W) + 2 * LOOP_PAD;
  const cx = W / 2;
  const out: Frag = { w: W, h: 0, nodes: [head], edges: [], entry: head.id };
  head.x = (W - head.w) / 2;
  const bodyTop = head.h + GAP_Y;
  let backY = head.h + 12;
  if (body.entry !== undefined) {
    shift(body, (W - body.w) / 2, bodyTop);
    out.nodes.push(...body.nodes);
    out.edges.push(...body.edges);
    out.edges.push({ from: head.id, to: body.entry, kind: "each", label: "each", labelAt: [cx + 22, head.h + 13], points: [[cx, head.h], [cx, bodyTop]] });
    const bodyBottom = bodyTop + body.h;
    backY = bodyBottom + 12;
    if (body.exit !== undefined) {
      const leftX = LOOP_PAD / 2;
      out.edges.push({ from: body.exit, to: head.id, kind: "back", points: [[cx, bodyBottom], [cx, backY], [leftX, backY], [leftX, head.h / 2], [head.x, head.h / 2]] });
    }
  }
  const exitBus = backY + 14;
  const joinTop = exitBus + 12;
  const join = mk.node("join", "join", "", JOIN, JOIN);
  join.x = cx - JOIN / 2;
  join.y = joinTop;
  out.nodes.push(join);
  const rightX = W - LOOP_PAD / 2;
  out.edges.push({
    from: head.id,
    to: join.id,
    kind: "exit",
    label: "done",
    labelAt: [rightX - 18, head.h / 2 - 7],
    points: [[head.x + head.w, head.h / 2], [rightX, head.h / 2], [rightX, exitBus], [cx, exitBus], [cx, joinTop]],
  });
  out.h = joinTop + JOIN;
  out.exit = join.id;
  return out;
}

function clipLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function piece(mk: Maker, item: Item): Frag {
  switch (item.t) {
    case "step":
      if (item.role === "marker") return single(mk.node("marker", "label", item.label, MARK_W, MARK_H, item.span ? { span: item.span } : {}));
      return single(mk.node(item.role, "step", item.label, STEP_W, STEP_H, { ...(item.title ? { title: item.title } : {}), ...(item.span ? { span: item.span } : {}), ...(item.target ? { target: item.target } : {}), ...(item.handler ? { handler: true as const } : {}) }));
    case "term":
      return single(mk.node(item.role, "exit", item.label, TERM_W, TERM_H, item.span ? { span: item.span } : {}), true);
    case "fork":
      return fork(mk, item);
    case "loop":
      return loop(mk, item);
  }
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

/** Lay out one function as a top-to-bottom flowchart. */
export function layoutFunction(fn: FunctionFacts): FunctionFlow {
  const stats = measure(fn.items);
  const base = { id: fn.id, name: fn.name, async: fn.async, ...(fn.span ? { span: fn.span } : {}), stats };
  if (countNodes(fn.items) > MAX_NODES) return { ...base, tooLarge: true, width: 0, height: 0, nodes: [], edges: [] };
  const mk = new Maker();
  const start = single(mk.node("start", "terminator", `${fn.async ? "async " : ""}${clipLabel(fn.name, STEP_LABEL)}`, STEP_W, TERM_H, { title: fn.name, ...(fn.span ? { span: fn.span } : {}) }));
  const body = stack(fn.items.map((i) => piece(mk, i)));
  const parts = [start, body];
  if (body.entry === undefined || body.exit !== undefined) parts.push(single(mk.node("end", "terminator", "end", TERM_W, TERM_H)));
  const whole = stack(parts);
  return { ...base, width: whole.w, height: whole.h, nodes: whole.nodes, edges: whole.edges };
}
