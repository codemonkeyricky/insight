// The travelling token of a control-flow chart: one dot that walks the chart's control flow from its start, round any loop
// (once or twice) and branch (alternating yes and no on successive runs), to its exit, then starts again. The route is pure
// (buildTokenRoute, unit tested). runFlowToken drives the dot on the page with one animation frame loop per chart and writes
// only its transform and visibility, so no React state changes per frame. useTokenSlot caps how many charts animate.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { FlowEdge, FlowNode, FunctionFlow } from "@insight/flow";
import { backEdgeFlags } from "./flowMotion";

/** The token's speed along a path, in chart units a second. */
export const TOKEN_SPEED = 120;
/** How long the token rests on each node it reaches, in ms. */
export const TOKEN_PAUSE_MS = 150;
/** The most charts whose token moves at once: the most recently opened ones. */
export const TOKEN_SLOTS = 6;
/** A cap on the edges of one run, so a flow that never reaches an exit (a cycle with no loop head) still stops. */
export const TOKEN_MAX_LEGS = 200;

/** One run of the token: the nodes it reaches in order, and the edge (by index) it takes from each node to the next. */
export interface TokenRoute {
  nodes: string[];
  edges: number[];
}

const push = (m: Map<string, number[]>, k: string, v: number) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/** A loop head's exit edge leaves the loop; the rest of its edges go round the body. */
const isExit = (kind: FlowEdge["kind"] | undefined) => kind === "exit" || kind === "false";

/** A branch takes its yes (true) edge first, then the others in the order the layout gave them. */
const branchRank = (kind: FlowEdge["kind"] | undefined) => (kind === "true" ? 0 : 1);

/** How many times a run may go round a loop's back-edge before it takes the loop's exit. */
export const LOOP_PASSES = 2;

/**
 * Walks a chart's control flow one run at a time. The walker keeps a count of how often each edge has been taken, across
 * runs. At a branch it takes the least-taken edge (ties: yes first, then the layout's order), so every branch is tried in
 * turn and nested branches reach every combination. A loop head is passed LOOP_PASSES times round its back-edge per entry,
 * then taken out by its exit. Exception edges are not followed. A run stops at a node with no way on, or after
 * TOKEN_MAX_LEGS edges.
 */
export function createTokenWalker(allNodes: readonly FlowNode[], allEdges: readonly FlowEdge[]): () => TokenRoute {
  // The token walks the outer chart only: a nested callee's steps (their ids hold a slash) are passed over.
  const nodes = allNodes.filter((n) => !n.id.includes("/"));
  // The route's edge numbers index the chart's own edges, which the rendered paths use.
  const keep = allEdges.flatMap((e, i) => (e.from.includes("/") || e.to.includes("/") ? [] : [i]));
  const edges = keep.map((i) => allEdges[i] as FlowEdge);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const back = backEdgeFlags(nodes, edges);
  const outs = new Map<string, number[]>();
  const backs = new Map<string, number[]>();
  const reached = new Set<string>();
  edges.forEach((e, i) => {
    if (!byId.has(e.from) || !byId.has(e.to)) return;
    if (back[i]) push(backs, e.from, i);
    else if (e.kind !== "exception") {
      push(outs, e.from, i);
      reached.add(e.to);
    }
  });
  const entry = nodes.find((n) => n.role === "start") ?? nodes.find((n) => n.shape !== "label" && !reached.has(n.id)) ?? nodes[0];
  // How many times each edge has been taken, over all runs so far.
  const taken = new Array<number>(edges.length).fill(0);
  const count = (i: number) => taken[i] ?? 0;

  return () => {
    if (entry === undefined) return { nodes: [], edges: [] };
    const route: TokenRoute = { nodes: [entry.id], edges: [] };
    // How many times the token has entered each loop head in the loop it is in now.
    const arrivals = new Map<string, number>([[entry.id, 1]]);
    let at = entry;
    while (route.edges.length < TOKEN_MAX_LEGS) {
      const o = outs.get(at.id) ?? [];
      let pick: number | undefined;
      if (at.shape === "loop" && o.length > 0) {
        const exit = o.find((i) => isExit(edges[i]?.kind));
        const body = o.find((i) => i !== exit);
        const round = arrivals.get(at.id) ?? 1;
        if (round <= LOOP_PASSES && body !== undefined) {
          pick = body;
        } else {
          pick = exit ?? body;
          arrivals.delete(at.id);
        }
      } else if (o.length > 1) {
        // Least-taken first; among equals, yes before no, then the layout's order (the sort is stable).
        const ordered = [...o].sort((a, b) => count(a) - count(b) || branchRank(edges[a]?.kind) - branchRank(edges[b]?.kind));
        pick = ordered[0];
      } else if (o.length === 1) {
        pick = o[0];
      } else {
        pick = backs.get(at.id)?.[0];
      }
      if (pick === undefined) break;
      const step = edges[pick];
      const to = step === undefined ? undefined : byId.get(step.to);
      if (to === undefined) break;
      taken[pick] = count(pick) + 1;
      route.edges.push(keep[pick] as number);
      route.nodes.push(to.id);
      arrivals.set(to.id, (arrivals.get(to.id) ?? 0) + 1);
      at = to;
    }
    return route;
  };
}

/** The route of one run, from a fresh walker: a convenience for a single run. */
export function buildTokenRoute(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): TokenRoute {
  return createTokenWalker(nodes, edges)();
}

/** One stretch of the token's timeline: a rest on a node, or a move along an edge's path. */
type Seg = { pause: true; node: string; x: number; y: number; ms: number } | { pause: false; path: SVGPathElement; len: number; ms: number };

/**
 * Starts the token on a rendered chart: it walks the route run after run, moving along each edge's path at TOKEN_SPEED and
 * resting TOKEN_PAUSE_MS on each node. The token is hidden while it rests and shown while it moves along an edge, so it reads
 * as travelling along the lines and never lights a box. Returns the stop.
 * A chart with no edge to walk gets no token.
 */
export function runFlowToken(svg: SVGSVGElement, tok: SVGGElement, fn: FunctionFlow): () => void {
  const pathEl = new Map<number, SVGPathElement>();
  svg.querySelectorAll("[data-edge]").forEach((el) => {
    const p = el.firstElementChild;
    if (p instanceof SVGPathElement) pathEl.set(Number(el.getAttribute("data-edge")), p);
  });
  const byId = new Map(fn.nodes.map((n) => [n.id, n] as const));

  const walk = createTokenWalker(fn.nodes, fn.edges);
  const build = (): Seg[] => {
    const route = walk();
    const segs: Seg[] = [];
    route.nodes.forEach((id, k) => {
      const n = byId.get(id);
      if (n === undefined) return;
      segs.push({ pause: true, node: id, x: n.x + n.w / 2, y: n.y + n.h / 2, ms: TOKEN_PAUSE_MS });
      const e = route.edges[k];
      if (e === undefined) return;
      const path = pathEl.get(e);
      if (path === undefined) return;
      const len = path.getTotalLength();
      if (len > 0) segs.push({ pause: false, path, len, ms: (len / TOKEN_SPEED) * 1000 });
    });
    return segs;
  };

  let segs = build();
  if (!segs.some((s) => !s.pause)) return () => undefined;
  let i = 0;
  let segStart = -1;
  let raf = 0;
  // The token shows only while it moves along an edge: a rest on a node hides it.
  const show = (s: Seg | undefined) => tok.setAttribute("visibility", s !== undefined && !s.pause ? "visible" : "hidden");
  const first = segs[0];
  if (first?.pause) tok.setAttribute("transform", `translate(${first.x} ${first.y})`);

  const frame = (now: number) => {
    if (segStart < 0) {
      segStart = now;
      show(segs[0]);
    }
    let seg = segs[i];
    while (seg !== undefined && now - segStart >= seg.ms) {
      segStart += seg.ms;
      i += 1;
      if (i >= segs.length) {
        segs = build();
        i = 0;
        if (segs.length === 0) return;
      }
      seg = segs[i];
      show(seg);
    }
    if (seg === undefined) return;
    const p = seg.ms > 0 ? Math.min(1, (now - segStart) / seg.ms) : 0;
    if (seg.pause) {
      tok.setAttribute("transform", `translate(${seg.x} ${seg.y})`);
    } else {
      const q = seg.path.getPointAtLength(p * seg.len);
      tok.setAttribute("transform", `translate(${q.x} ${q.y})`);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
  };
}

// The slot registry. Each chart with a token registers when it mounts (its order is its opening order). A chart's token is
// active when the chart is eligible (on screen, page visible, motion on, not reduced) and fewer than TOKEN_SLOTS eligible
// charts were opened after it.
const slots = new Map<string, { seq: number; eligible: boolean }>();
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Whether the chart `key` may animate its token now. Read by the chart's React snapshot. */
export function tokenSlotActive(key: string): boolean {
  const me = slots.get(key);
  if (me === undefined || !me.eligible) return false;
  let newer = 0;
  for (const [k, s] of slots) if (k !== key && s.eligible && s.seq > me.seq) newer++;
  return newer < TOKEN_SLOTS;
}

/** Registers the chart `key` (once, in opening order) and reports whether its token animates. */
export function useTokenSlot(key: string, eligible: boolean): boolean {
  useEffect(() => {
    if (!slots.has(key)) slots.set(key, { seq: ++seq, eligible: false });
    return () => {
      slots.delete(key);
      notify();
    };
  }, [key]);
  useEffect(() => {
    const s = slots.get(key);
    if (s !== undefined) s.eligible = eligible;
    notify();
  }, [key, eligible]);
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  const snapshot = useCallback(() => tokenSlotActive(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
