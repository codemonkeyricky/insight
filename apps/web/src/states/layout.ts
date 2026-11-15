// Lays a state machine out as a state diagram: boxes in layers (top to bottom), arcs routed around them, labels placed
// by ELK. The solver is injected: the page passes the worker client (states/elkClient.ts), tests pass the bundled solver.
import type { ElkNode, ElkExtendedEdge, ElkEdgeSection, ElkLabel } from "elkjs/lib/elk-api";
import type { StateMachineView } from "../api";

export type Solve = (graph: ElkNode) => Promise<ElkNode>;

export interface LaidState {
  id: string;
  label: string;
  kind: "initial" | "any" | "state" | "unentered";
  x: number;
  y: number;
  w: number;
  h: number;
  /** No outgoing arc to another state (a state that is only ever entered). */
  terminal: boolean;
}

export interface LaidLabel {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidArc {
  id: string;
  from: string;
  to: string;
  selfLoop: boolean;
  /** The SVG path of the arc, without the arrowhead. */
  d: string;
  /** The arrowhead polygon (SVG path) at the end of the arc. */
  arrow: string;
  /** The arc's corner points before rounding (empty for a self-loop). */
  points: { x: number; y: number }[];
  label?: LaidLabel;
}

export interface LaidMachine {
  width: number;
  height: number;
  states: LaidState[];
  arcs: LaidArc[];
}

const CHAR_W = 7; // estimated text width at 12px
const MARGIN = 28;
const LOOP_W = 30;

export const labelSize = (text: string): { w: number; h: number } => ({ w: Math.ceil(text.length * CHAR_W) + 14, h: 22 });

function stateSize(kind: LaidState["kind"], label: string, loops: number): { w: number; h: number } {
  if (kind === "initial") return { w: 20, h: 20 };
  const h = Math.max(40, 14 + loops * 26);
  if (kind === "any") return { w: Math.max(96, label.length * 7.5 + 36), h: 30 };
  return { w: Math.max(96, Math.ceil(label.length * 7.5 + 36)), h };
}

type Pt = { x: number; y: number };

/** An orthogonal polyline drawn with rounded corners. */
export function roundedPath(points: Pt[], radius = 9): string {
  const pts = points.filter((p, i) => i === 0 || p.x !== (points[i - 1] as Pt).x || p.y !== (points[i - 1] as Pt).y);
  if (pts.length < 2) return "";
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M${f((pts[0] as Pt).x)},${f((pts[0] as Pt).y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = { x: b.x + ((a.x - b.x) / l1) * r, y: b.y + ((a.y - b.y) / l1) * r };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * r, y: b.y + ((c.y - b.y) / l2) * r };
    d += ` L${f(p1.x)},${f(p1.y)} Q${f(b.x)},${f(b.y)} ${f(p2.x)},${f(p2.y)}`;
  }
  const last = pts[pts.length - 1] as Pt;
  return `${d} L${f(last.x)},${f(last.y)}`;
}

/** The arrowhead whose tip is `tip`, pointing along (dx, dy). */
export function arrowHead(tip: Pt, dx: number, dy: number): string {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip.x - ux * 9;
  const by = tip.y - uy * 9;
  const f = (n: number) => Math.round(n * 10) / 10;
  return `M${f(tip.x)},${f(tip.y)} L${f(bx - uy * 4.5)},${f(by + ux * 4.5)} L${f(bx + uy * 4.5)},${f(by - ux * 4.5)} Z`;
}

/** Builds the ELK graph for a machine. Self-loops are left out (drawn by hand) but make room beside their state. */
export function buildGraph(view: StateMachineView): { graph: ElkNode; loops: Map<string, number> } {
  const loops = new Map<string, number>();
  const edges = view.transitions.filter((t) => t.from === t.to);
  for (const t of edges) loops.set(t.from, (loops.get(t.from) ?? 0) + 1);
  const ids = new Set(view.states.map((s) => s.id));
  const children: ElkNode[] = view.states.map((s, i) => {
    const size = stateSize(s.kind, s.label, loops.get(s.id) ?? 0);
    const loopLabels = view.transitions.filter((t) => t.from === s.id && t.to === s.id);
    const extra = loopLabels.length ? LOOP_W + Math.max(...loopLabels.map((t) => (t.label ? labelSize(t.label).w : 0))) + 6 : 0;
    const node: ElkNode = { id: `n${i}`, width: size.w + extra, height: size.h };
    if (s.kind === "initial" || s.kind === "any") {
      node.layoutOptions = { "org.eclipse.elk.layered.layering.layerConstraint": "FIRST" };
    }
    else if (!view.transitions.some((t) => t.from === s.id || t.to === s.id)) {
      // A state nothing connects to goes last, so it does not sit beside the start dot.
      node.layoutOptions = { "org.eclipse.elk.layered.layering.layerConstraint": "LAST" };
    }
    return node;
  });
  const index = new Map(view.states.map((s, i) => [s.id, i]));
  const elkEdges: ElkExtendedEdge[] = [];
  view.transitions.forEach((t, i) => {
    if (t.from === t.to || !ids.has(t.from) || !ids.has(t.to)) return;
    const e: ElkExtendedEdge = { id: `e${i}`, sources: [`n${index.get(t.from)}`], targets: [`n${index.get(t.to)}`] };
    if (t.label) {
      const size = labelSize(t.label);
      const label: ElkLabel = {
        text: t.label,
        width: size.w,
        height: size.h,
        layoutOptions: { "org.eclipse.elk.edgeLabels.placement": "CENTER" },
      };
      e.labels = [label];
    }
    elkEdges.push(e);
  });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "org.eclipse.elk.algorithm": "layered",
      "org.eclipse.elk.direction": "DOWN",
      "org.eclipse.elk.edgeRouting": "ORTHOGONAL",
      "org.eclipse.elk.separateConnectedComponents": "false",
      "org.eclipse.elk.spacing.nodeNode": "44",
      "org.eclipse.elk.spacing.edgeNode": "28",
      "org.eclipse.elk.spacing.edgeEdge": "20",
      "org.eclipse.elk.spacing.edgeLabel": "6",
      "org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers": "48",
      "org.eclipse.elk.layered.spacing.edgeNodeBetweenLayers": "30",
      "org.eclipse.elk.layered.spacing.edgeEdgeBetweenLayers": "20",
      "org.eclipse.elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "org.eclipse.elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "org.eclipse.elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "org.eclipse.elk.padding": `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]`,
    },
    children,
    edges: elkEdges,
  };
  return { graph, loops };
}

function sectionPoints(section: ElkEdgeSection): Pt[] {
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
}

/**
 * ELK puts a centre label beside its arc; sit it on the arc instead. Candidates run along the segments nearest to where
 * ELK put the label (the last candidate is ELK's own spot); the first one that touches no placed label or state box wins.
 */
function labelCandidates(text: string, l: ElkLabel, pts: Pt[]): LaidLabel[] {
  const w = l.width ?? labelSize(text).w;
  const h = l.height ?? 22;
  const cx = (l.x ?? 0) + w / 2;
  const cy = (l.y ?? 0) + h / 2;
  const segs: { d: number; spots: Pt[] }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const spots: Pt[] = [];
    const usable = len - 2 * Math.min(14, len / 2 - 0.5);
    const m = Math.max(1, Math.floor(usable / (h + 4)));
    const fr = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].slice(0, Math.min(7, m + 2));
    for (const f of fr) spots.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    segs.push({ d: Math.hypot(mid.x - cx, mid.y - cy) - len / 4, spots });
  }
  segs.sort((p, q) => p.d - q.d);
  const out: LaidLabel[] = [];
  for (const sg of segs.slice(0, 3)) for (const sp of sg.spots) out.push({ text, x: sp.x - w / 2, y: sp.y - h / 2, w, h });
  out.push({ text, x: l.x ?? 0, y: l.y ?? 0, w, h });
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };
const touches = (a: Rect, b: Rect, pad = 3) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/** True when an orthogonal (or any straight) polyline passes through the rectangle grown by `pad`. */
export function polylineHitsRect(pts: Pt[], r: Rect, pad = 4): boolean {
  const x0 = r.x - pad;
  const y0 = r.y - pad;
  const x1 = r.x + r.w + pad;
  const y1 = r.y + r.h + pad;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    // Liang-Barsky clip of the segment against the rectangle.
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const clip = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
      return true;
    };
    if (clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dy, a.y - y0) && clip(dy, y1 - a.y)) return true;
  }
  return false;
}

/** Lays the machine out. Deterministic for a given view and solver. */
export async function layoutMachine(view: StateMachineView, solve: Solve): Promise<LaidMachine> {
  const { graph, loops } = buildGraph(view);
  const solved = await solve(graph);
  const nodeById = new Map((solved.children ?? []).map((n) => [n.id, n]));
  const outgoing = new Set(view.transitions.filter((t) => t.from !== t.to).map((t) => t.from));
  // An "any state" arc `* -> X` lets every state except X leave.
  const anyIds = new Set(view.states.filter((s) => s.kind === "any").map((s) => s.id));
  const anyTargets = view.transitions.filter((t) => anyIds.has(t.from) && t.from !== t.to).map((t) => t.to);
  const canLeave = (id: string) => outgoing.has(id) || anyTargets.some((to) => to !== id);

  const states: LaidState[] = view.states.map((s, i) => {
    const n = nodeById.get(`n${i}`) as ElkNode;
    const size = stateSize(s.kind, s.label, loops.get(s.id) ?? 0);
    return {
      id: s.id,
      label: s.label,
      kind: s.kind,
      x: n.x ?? 0,
      y: n.y ?? 0,
      w: size.w,
      h: size.h,
      terminal: s.kind === "state" && !canLeave(s.id),
    };
  });
  const stateById = new Map(states.map((s) => [s.id, s]));
  const edgeById = new Map((solved.edges ?? []).map((e) => [e.id, e as ElkExtendedEdge]));

  const arcs: LaidArc[] = [];
  const loopSeen = new Map<string, number>();
  const pending: { arc: LaidArc; candidates: LaidLabel[] }[] = [];
  const polys = new Map<string, Pt[]>();
  let width = solved.width ?? 0;
  let height = solved.height ?? 0;
  view.transitions.forEach((t, i) => {
    const from = stateById.get(t.from);
    const to = stateById.get(t.to);
    if (!from || !to) return;
    if (t.from === t.to) {
      const k = loopSeen.get(t.from) ?? 0;
      loopSeen.set(t.from, k + 1);
      const n = loops.get(t.from) ?? 1;
      const cy = from.y + from.h / 2 + (k - (n - 1) / 2) * 26;
      const x0 = from.x + from.w;
      const r = 9;
      const d = `M${x0},${cy - r} C${x0 + LOOP_W},${cy - r - 10} ${x0 + LOOP_W},${cy + r + 10} ${x0 + 1},${cy + r}`;
      const label = t.label
        ? { text: t.label, ...labelSize(t.label), x: x0 + LOOP_W - 4, y: cy - labelSize(t.label).h / 2 }
        : undefined;
      arcs.push({ id: t.id, from: t.from, to: t.to, selfLoop: true, d, points: [], arrow: arrowHead({ x: x0, y: cy + r }, -1, 0.15), ...(label ? { label } : {}) });
      if (label) width = Math.max(width, label.x + label.w + MARGIN);
      return;
    }
    const e = edgeById.get(`e${i}`);
    const section = e?.sections?.[0];
    if (!section) return;
    const pts = sectionPoints(section).map((p) => ({ x: p.x, y: p.y }));
    // A node made wider to leave room for a self-loop is still drawn at its own width: pull end points back to the box.
    for (const [idx, st] of [[0, from], [pts.length - 1, to]] as const) {
      const p = pts[idx] as Pt;
      if (p.x > st.x + st.w && p.y >= st.y && p.y <= st.y + st.h) p.x = st.x + st.w;
    }
    const lastP = pts[pts.length - 1] as Pt;
    const prev = pts[pts.length - 2] as Pt;
    const dx = lastP.x - prev.x;
    const dy = lastP.y - prev.y;
    // Stop the line short of the tip so the arrowhead does not sit on a thick stroke.
    const body = pts.slice();
    const len = Math.hypot(dx, dy) || 1;
    body[body.length - 1] = { x: lastP.x - (dx / len) * 6, y: lastP.y - (dy / len) * 6 };
    const l = e?.labels?.[0];
    const arc: LaidArc = { id: t.id, from: t.from, to: t.to, selfLoop: false, d: roundedPath(body), points: pts, arrow: arrowHead(lastP, dx, dy) };
    arcs.push(arc);
    polys.set(arc.id, pts);
    if (t.label && l) pending.push({ arc, candidates: labelCandidates(t.label, l, pts) });
  });
  const placed: Rect[] = arcs.flatMap((a) => (a.label ? [a.label] : []));
  for (const { arc, candidates } of pending) {
    // A label sits on its own arc, never on another arc's line: that would cover the other arc and steal its clicks.
    const clear = (c: LaidLabel) => !placed.some((r) => touches(c, r)) && !states.some((s) => touches(c, s, 2));
    const onOther = (c: LaidLabel) => [...polys].some(([id, pts]) => id !== arc.id && polylineHitsRect(pts, c));
    const free = candidates.find((c) => clear(c) && !onOther(c)) ?? candidates.find(clear);
    const chosen = free ?? (candidates[0] as LaidLabel);
    arc.label = chosen;
    placed.push(chosen);
  }
  for (const a of arcs) {
    if (a.label) {
      width = Math.max(width, a.label.x + a.label.w + MARGIN);
      height = Math.max(height, a.label.y + a.label.h + MARGIN);
    }
  }
  for (const s of states) {
    width = Math.max(width, s.x + s.w + MARGIN);
    height = Math.max(height, s.y + s.h + MARGIN);
  }
  return { width: Math.ceil(width), height: Math.ceil(height), states, arcs };
}

/** Distance from (px, py) to the segment a-b. */
function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/**
 * The arc whose line passes closest to (x, y), within `max` px; undefined when none does. Where two lines cross or run
 * side by side under one pointer, the nearer one is the one meant.
 */
export function nearestArc(arcs: readonly LaidArc[], x: number, y: number, max = 12): LaidArc | undefined {
  let best: LaidArc | undefined;
  let bestD = max;
  for (const a of arcs) {
    for (let i = 1; i < a.points.length; i++) {
      const d = distToSegment(x, y, a.points[i - 1] as Pt, a.points[i] as Pt);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
  }
  return best;
}
