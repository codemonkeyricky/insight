// The zoom map's expansions: a function's control-flow chart drawn in a box beside the map. An expansion is anchored to a
// function box on the map, or to a call step in another expansion's chart, and sits to the right of its anchor. The
// layout never depends on expansions (a function box keeps its compact size), so everything here is placement: where
// each expansion goes, how a chain follows its parent, what closes with what, and how the camera shows a new one. Pure,
// so these rules are unit tested (test/expand.test.ts).
import { CHART_FIT_MAX_K, CHART_HEAD, CHART_PAD, type Camera, type FunctionFlow, type Rect } from "@insight/flow";

/** The room between an anchor and the expansion beside it. */
export const EXPAND_GAP = 40;
/** The top of an expansion stays at least this far above the view's bottom edge: two header heights. */
const HEAD_ROOM = 2 * CHART_HEAD;
/** The room a reveal keeps between an expansion and the stage's edges. */
const REVEAL_MARGIN = 16;

/**
 * What an expansion hangs from. A box is a function's box on the map, with its placed rect. A step is a call step in
 * the chart of the expansion of `fnId`, with the step's rect in that chart's units (its top-left is the chart's origin
 * plus this rect's corner).
 */
export type ExpandAnchor = { kind: "box"; nodeId: string; rect: Rect } | { kind: "step"; fnId: string; rect: Rect };

/** One open expansion. Identity is the function: a function has at most one expansion open. */
export interface Expansion {
  fnId: string;
  anchor: ExpandAnchor;
  chart: FunctionFlow;
  /** The top-left corner and size of the box, in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The size of an expansion box that holds a chart of `chart`'s natural size, with its header and padding. */
export function expansionSize(chart: { width: number; height: number }): { w: number; h: number } {
  return { w: chart.width + 2 * CHART_PAD, h: CHART_HEAD + CHART_PAD + chart.height + CHART_PAD };
}

/** The corner a chart is drawn at inside an expansion: under the header, inset by the padding. */
export function contentOrigin(e: { x: number; y: number }): { x: number; y: number } {
  return { x: e.x + CHART_PAD, y: e.y + CHART_HEAD + CHART_PAD };
}

/**
 * The top of an expansion whose anchor is at `desired`, kept on the view: its header never starts below the view's bottom
 * edge less two header heights, so an expansion opened low on the map is pulled up into view. Clamped once, when it is
 * placed, so a later pan does not move it.
 */
export function clampTop(desired: number, view: Rect): number {
  return Math.min(desired, view.y + view.h - HEAD_ROOM);
}

/** Where an expansion beside a function box goes: right of the box, top level with the box's top (see clampTop). */
export function placeOnBox(rect: Rect, view: Rect): { x: number; y: number } {
  return { x: rect.x + rect.w + EXPAND_GAP, y: clampTop(rect.y, view) };
}

/**
 * Where a call step's expansion goes: right of the expansion the step is in, top level with the step (see clampTop).
 * `rect` is the step in its parent's chart units.
 */
export function placeOnStep(parent: Expansion, rect: Rect, view: Rect): { x: number; y: number } {
  return { x: parent.x + parent.w + EXPAND_GAP, y: clampTop(contentOrigin(parent).y + rect.y, view) };
}

/**
 * Places every expansion from its anchor, each parent before the children it holds. An expansion whose parent is not in
 * the list is dropped with its chain. The list's order is kept.
 */
export function reflow(list: readonly Expansion[], view: Rect): Expansion[] {
  const byFn = new Map(list.map((e) => [e.fnId, e] as const));
  const placed = new Map<string, Expansion>();
  const place = (e: Expansion, hops: number): Expansion | undefined => {
    const done = placed.get(e.fnId);
    if (done !== undefined) return done;
    if (hops > list.length) return undefined;
    let at: { x: number; y: number };
    if (e.anchor.kind === "box") {
      at = placeOnBox(e.anchor.rect, view);
    } else {
      const parent = byFn.get(e.anchor.fnId);
      const from = parent === undefined ? undefined : place(parent, hops + 1);
      if (from === undefined) return undefined;
      at = placeOnStep(from, e.anchor.rect, view);
    }
    const out: Expansion = { ...e, ...at };
    placed.set(e.fnId, out);
    return out;
  };
  return list.flatMap((e) => {
    const p = place(e, 0);
    return p === undefined ? [] : [p];
  });
}

/**
 * The list after the map is drawn for a new build. A box's anchor takes the box's rect in the new build (`rectOf`), and an
 * expansion whose box is no longer drawn is dropped, with the chain it holds. Everything is placed again on `view`.
 */
export function refresh(list: readonly Expansion[], rectOf: (nodeId: string) => Rect | undefined, view: Rect): Expansion[] {
  const kept: Expansion[] = [];
  for (const e of list) {
    if (e.anchor.kind !== "box") {
      kept.push(e);
      continue;
    }
    const rect = rectOf(e.anchor.nodeId);
    if (rect !== undefined) kept.push({ ...e, anchor: { ...e.anchor, rect } });
  }
  return reflow(kept, view);
}

/** True when `target` is `from`, or an expansion `from` is chained from, through step anchors. Opening it would cycle. */
function chainHas(list: readonly Expansion[], from: string, target: string): boolean {
  let cur: string | undefined = from;
  for (let hops = 0; cur !== undefined && hops <= list.length; hops++) {
    if (cur === target) return true;
    const e = list.find((x) => x.fnId === cur);
    cur = e?.anchor.kind === "step" ? e.anchor.fnId : undefined;
  }
  return false;
}

/**
 * The list after `fnId`'s expansion opens at `anchor`, drawing `chart`. An expansion that is already open is reattached:
 * its anchor moves and the chains from it follow, so a function never has two. The new one is last, so Escape closes it
 * first. Returns `list` itself when the anchor is inside `fnId`'s own chain, which would cycle.
 */
export function openExpansion(list: readonly Expansion[], fnId: string, anchor: ExpandAnchor, chart: FunctionFlow, view: Rect): Expansion[] {
  if (anchor.kind === "step" && chainHas(list, anchor.fnId, fnId)) return list as Expansion[];
  const size = expansionSize(chart);
  const others = list.filter((e) => e.fnId !== fnId);
  return reflow([...others, { fnId, anchor, chart, ...size, x: 0, y: 0 }], view);
}

/** The list without `fnId`'s expansion and every expansion chained from it, at any depth. */
export function closeExpansion(list: readonly Expansion[], fnId: string): Expansion[] {
  const gone = new Set([fnId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of list) {
      if (e.anchor.kind === "step" && gone.has(e.anchor.fnId) && !gone.has(e.fnId)) {
        gone.add(e.fnId);
        grew = true;
      }
    }
  }
  return list.filter((e) => !gone.has(e.fnId));
}

/** The expansion anchored to a function box, if one is open. */
export function anchoredTo(list: readonly Expansion[], nodeId: string): Expansion | undefined {
  return list.find((e) => e.anchor.kind === "box" && e.anchor.nodeId === nodeId);
}

/** The line from an expansion's anchor (the box's or the step's right edge, middle) to the expansion's left edge, header high. */
export function connectorOf(e: Expansion, list: readonly Expansion[]): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const x2 = e.x;
  const y2 = e.y + CHART_HEAD / 2;
  if (e.anchor.kind === "box") {
    const r = e.anchor.rect;
    return { x1: r.x + r.w, y1: r.y + r.h / 2, x2, y2 };
  }
  const parentId = e.anchor.fnId;
  const parent = list.find((p) => p.fnId === parentId);
  if (parent === undefined) return undefined;
  const o = contentOrigin(parent);
  const r = e.anchor.rect;
  return { x1: o.x + r.x + r.w, y1: o.y + r.y + r.h / 2, x2, y2 };
}

/** Moves a span of `size` that starts at `start` inside a room of `room`, the least that keeps it in the room. */
function shift(start: number, size: number, room: number): number {
  if (size > room - 2 * REVEAL_MARGIN || start < REVEAL_MARGIN) return REVEAL_MARGIN - start;
  if (start + size > room - REVEAL_MARGIN) return room - REVEAL_MARGIN - (start + size);
  return 0;
}

/**
 * The camera that shows an expansion `rect` (world units) whose chart is `chartW` wide. A chart narrower than `minPx` on
 * screen is zoomed in, at most 1.5 times the current scale, about the expansion's top-left corner, which stays where it
 * was. Then the camera pans the least that brings the expansion inside `room`; one larger than the room is aligned to its
 * top-left. A camera that already shows it is returned unchanged.
 */
export function revealCamera(cam: Camera, rect: Rect, chartW: number, room: { width: number; height: number }, minPx: number): Camera {
  let k = cam.k;
  if (chartW * k < minPx) k = Math.min(minPx / chartW, cam.k * CHART_FIT_MAX_K);
  let x = cam.x + rect.x * (cam.k - k);
  let y = cam.y + rect.y * (cam.k - k);
  x += shift(rect.x * k + x, rect.w * k, room.width);
  y += shift(rect.y * k + y, rect.h * k, room.height);
  return { k, x, y };
}
